package server

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

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
	State    string `json:"state"`    // ok | warning | error
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
	Numeric   bool   `json:"numeric"` // graphable (value_type float or unsigned)
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

	out := make([]hostView, 0, len(hosts))
	for _, h := range hosts {
		hv := hostView{ID: h.HostID, Name: h.Name, Enabled: h.Status == "0", Severity: -1, State: "ok"}
		if n := count[h.HostID]; n > 0 {
			hv.Problems = n
			hv.Severity = worst[h.HostID]
			hv.State = severityState(worst[h.HostID])
		}
		out = append(out, hv)
	}
	writeJSON(w, http.StatusOK, out)
}

type problemView struct {
	Name     string   `json:"name"`
	Severity int      `json:"severity"`
	State    string   `json:"state"`
	ItemIDs  []string `json:"item_ids"`
}

func (s *Server) handleHostProblems(w http.ResponseWriter, r *http.Request) {
	if !s.zbx.Authenticated() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Zabbix API token not configured (set ARGUS_ZABBIX_API_TOKEN)"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()

	triggers, err := s.zbx.HostProblems(ctx, r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
		return
	}
	out := make([]problemView, 0, len(triggers))
	for _, t := range triggers {
		sev := atoi(t.Priority)
		pv := problemView{Name: t.Description, Severity: sev, State: severityState(sev), ItemIDs: []string{}}
		for _, it := range t.Items {
			pv.ItemIDs = append(pv.ItemIDs, it.ItemID)
		}
		out = append(out, pv)
	}
	writeJSON(w, http.StatusOK, out)
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
	out := make([]itemView, 0, len(items))
	for _, it := range items {
		var clock int64
		if it.LastClock != "" {
			clock, _ = strconv.ParseInt(it.LastClock, 10, 64)
		}
		out = append(out, itemView{
			ID:        it.ItemID,
			Name:      it.Name,
			Key:       it.Key,
			LastValue: it.LastValue,
			Units:     it.Units,
			LastClock: clock,
			Supported: it.State == "0",
			Enabled:   it.Status == "0",
			Numeric:   numericValueType(it.ValueType),
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
