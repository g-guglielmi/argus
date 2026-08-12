package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"argus/internal/auth"
)

// decodeOptional decodes a small JSON body if present, ignoring an empty/absent body.
func decodeOptional(w http.ResponseWriter, r *http.Request, dst any) {
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(dst)
}

// severityState maps a Zabbix trigger severity (0..5) to Argus's OK/Warning/Error model.
// info/unclassified -> ok, warning -> warning, average/high/disaster -> error.
func severityState(sev int) string {
	switch {
	case sev >= 3:
		return "error"
	case sev == 2:
		return "warning"
	default:
		return "ok"
	}
}

type hostView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Enabled  bool   `json:"enabled"`
	Problems int    `json:"problems"`
	Severity int    `json:"severity"` // -1 when no active problem, else 0..5
	State    string `json:"state"`    // ok | warning | error | paused
	Paused   bool   `json:"paused"`
}

type itemView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Key       string `json:"key"`
	LastValue string `json:"last_value"`
	Units     string `json:"units"`
	LastClock int64  `json:"last_clock"` // unix seconds, 0 if never
	Supported bool   `json:"supported"`
	Enabled   bool   `json:"enabled"`
	Numeric   bool   `json:"numeric"`            // graphable (value_type float or unsigned)
	Paused    bool   `json:"paused"`
	Category  string `json:"category,omitempty"` // set in curated mode
	Label     string `json:"label,omitempty"`    // friendly name in curated mode
}

// numericValueType reports whether a Zabbix value_type is graphable (0 float, 3 unsigned).
func numericValueType(vt string) bool { return vt == "0" || vt == "3" }

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func (s *Server) handleHosts(w http.ResponseWriter, r *http.Request) {
	if !s.zbx.Authenticated() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Zabbix API token not configured (set ARGUS_ZABBIX_API_TOKEN)"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()

	hosts, err := s.zbx.Hosts(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
		return
	}

	// Aggregate active problems per host (best-effort: if this fails, hosts still list as ok).
	worst := map[string]int{}
	count := map[string]int{}
	if triggers, err := s.zbx.ActiveTriggers(ctx); err == nil {
		for _, t := range triggers {
			if t.Value != "1" {
				continue
			}
			sev := atoi(t.Priority)
			for _, h := range t.Hosts {
				count[h.HostID]++
				if sev > worst[h.HostID] {
					worst[h.HostID] = sev
				}
			}
		}
	}

	paused, _ := s.st.PausedSet(ctx, "host")

	out := make([]hostView, 0, len(hosts))
	for _, h := range hosts {
		hv := hostView{ID: h.HostID, Name: h.Name, Enabled: h.Status == "0", Severity: -1, State: "ok"}
		if n := count[h.HostID]; n > 0 {
			hv.Problems = n
			hv.Severity = worst[h.HostID]
			hv.State = severityState(worst[h.HostID])
		}
		if paused[h.HostID] {
			hv.Paused = true
			hv.State = "paused"
		}
		out = append(out, hv)
	}
	writeJSON(w, http.StatusOK, out)
}

type problemView struct {
	EventID      string   `json:"event_id"`
	Name         string   `json:"name"`
	Severity     int      `json:"severity"`
	State        string   `json:"state"`
	Acknowledged bool     `json:"acknowledged"`
	ItemIDs      []string `json:"item_ids"`
}

func (s *Server) handleHostProblems(w http.ResponseWriter, r *http.Request) {
	if !s.zbx.Authenticated() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Zabbix API token not configured (set ARGUS_ZABBIX_API_TOKEN)"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()

	problems, err := s.zbx.Problems(ctx, r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
		return
	}
	// Best-effort: map each problem's trigger to the item(s) it references for highlighting.
	tids := make([]string, 0, len(problems))
	for _, p := range problems {
		tids = append(tids, p.ObjectID)
	}
	itemsByTrigger, _ := s.zbx.TriggerItems(ctx, tids)

	out := make([]problemView, 0, len(problems))
	for _, p := range problems {
		sev := atoi(p.Severity)
		ids := itemsByTrigger[p.ObjectID]
		if ids == nil {
			ids = []string{}
		}
		out = append(out, problemView{
			EventID:      p.EventID,
			Name:         p.Name,
			Severity:     sev,
			State:        severityState(sev),
			Acknowledged: p.Acknowledged == "1",
			ItemIDs:      ids,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/events/{id}/ack — acknowledge a Zabbix problem (any signed-in user).
func (s *Server) handleAckEvent(w http.ResponseWriter, r *http.Request) {
	if !s.zbx.Authenticated() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Zabbix API token not configured (set ARGUS_ZABBIX_API_TOKEN)"})
		return
	}
	var req struct {
		Message string `json:"message"`
	}
	decodeOptional(w, r, &req) // message is optional
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	if err := s.zbx.AcknowledgeEvent(ctx, r.PathValue("id"), req.Message); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// pauseHandler pauses a host or item in Argus (helpdesk/admin), by scope.
func (s *Server) pauseHandler(scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Note string `json:"note"`
		}
		decodeOptional(w, r, &req)
		caller, _ := auth.UserFrom(r.Context())
		var by int64
		if caller != nil {
			by = caller.ID
		}
		if err := s.st.SetPause(r.Context(), scope, r.PathValue("id"), by, req.Note); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// unpauseHandler resumes a host or item, by scope.
func (s *Server) unpauseHandler(scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := s.st.ClearPause(r.Context(), scope, r.PathValue("id")); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

func (s *Server) handleHostItems(w http.ResponseWriter, r *http.Request) {
	if !s.zbx.Authenticated() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Zabbix API token not configured (set ARGUS_ZABBIX_API_TOKEN)"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()

	items, err := s.zbx.Items(ctx, r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
		return
	}
	all := r.URL.Query().Get("all") == "1"
	pausedItems, _ := s.st.PausedSet(ctx, "item")
	out := make([]itemView, 0, len(items))
	for _, it := range items {
		var clock int64
		if it.LastClock != "" {
			clock, _ = strconv.ParseInt(it.LastClock, 10, 64)
		}
		iv := itemView{
			ID:        it.ItemID,
			Name:      it.Name,
			Key:       it.Key,
			LastValue: it.LastValue,
			Units:     it.Units,
			LastClock: clock,
			Supported: it.State == "0",
			Enabled:   it.Status == "0",
			Numeric:   numericValueType(it.ValueType),
			Paused:    pausedItems[it.ItemID],
		}
		if !all {
			cat, label, ok := classifyItem(it.Key, it.Name)
			if !ok {
				continue // hide un-curated "noise" in the default view
			}
			iv.Category, iv.Label = cat, label
		}
		out = append(out, iv)
	}
	if !all {
		sort.SliceStable(out, func(i, j int) bool {
			if ci, cj := categoryOrder[out[i].Category], categoryOrder[out[j].Category]; ci != cj {
				return ci < cj
			}
			return out[i].Label < out[j].Label
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// timeRange maps a UI range key to a lookback window and whether to read trends vs history.
// Short ranges use raw history (30-day retention); long ranges use trends (730-day retention).
type timeRange struct {
	dur   time.Duration
	trend bool
}

var timeRanges = map[string]timeRange{
	"2h": {2 * time.Hour, false},
	"2d": {48 * time.Hour, false},
	"1M": {30 * 24 * time.Hour, true},
	"3M": {90 * 24 * time.Hour, true},
	"6M": {180 * 24 * time.Hour, true},
	"1Y": {365 * 24 * time.Hour, true},
}

type seriesPoint struct {
	T   int64    `json:"t"`
	V   *float64 `json:"v,omitempty"`
	Min *float64 `json:"min,omitempty"`
	Avg *float64 `json:"avg,omitempty"`
	Max *float64 `json:"max,omitempty"`
}

type seriesResp struct {
	Name   string        `json:"name"`
	Units  string        `json:"units"`
	Kind   string        `json:"kind"` // history | trend
	Points []seriesPoint `json:"points"`
}

func pf(s string) *float64 {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &v
}

func (s *Server) handleItemHistory(w http.ResponseWriter, r *http.Request) {
	if !s.zbx.Authenticated() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Zabbix API token not configured (set ARGUS_ZABBIX_API_TOKEN)"})
		return
	}
	rng, ok := timeRanges[r.URL.Query().Get("range")]
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid range"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	itemID := r.PathValue("id")
	item, err := s.zbx.Item(ctx, itemID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
		return
	}
	if !numericValueType(item.ValueType) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "this sensor is not numeric and has no graph"})
		return
	}

	now := time.Now().Unix()
	from := now - int64(rng.dur.Seconds())
	resp := seriesResp{Name: item.Name, Units: item.Units, Points: []seriesPoint{}}

	if rng.trend {
		resp.Kind = "trend"
		pts, err := s.zbx.Trends(ctx, itemID, from, now)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
			return
		}
		for _, p := range pts {
			resp.Points = append(resp.Points, seriesPoint{T: atoi64(p.Clock), Min: pf(p.ValueMin), Avg: pf(p.ValueAvg), Max: pf(p.ValueMax)})
		}
	} else {
		resp.Kind = "history"
		pts, err := s.zbx.History(ctx, itemID, atoi(item.ValueType), from, now)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
			return
		}
		for _, p := range pts {
			resp.Points = append(resp.Points, seriesPoint{T: atoi64(p.Clock), V: pf(p.Value)})
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func atoi64(s string) int64 { n, _ := strconv.ParseInt(s, 10, 64); return n }
