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
}

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
		})
	}
	writeJSON(w, http.StatusOK, out)
}
