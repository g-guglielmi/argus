package server

import (
	"context"
	"net/http"
	"time"
)

type problemRow struct {
	EventID      string `json:"event_id"`
	Name         string `json:"name"`
	HostID       string `json:"host_id"`
	HostName     string `json:"host_name"`
	Severity     int    `json:"severity"`
	State        string `json:"state"` // ok | warning | error
	Acknowledged bool   `json:"acknowledged"`
	Clock        int64  `json:"clock"`
}

// handleProblems returns every active problem across all hosts, excluding those on hidden or
// paused hosts (and whose only sensors are hidden). The UI filters by severity/ack per view.
func (s *Server) handleProblems(w http.ResponseWriter, r *http.Request) {
	if !s.zbx.Authenticated() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Zabbix API token not configured (set ARGUS_ZABBIX_API_TOKEN)"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	problems, err := s.zbx.AllProblems(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Zabbix: " + err.Error()})
		return
	}

	tids := make([]string, 0, len(problems))
	for _, p := range problems {
		tids = append(tids, p.ObjectID)
	}
	targets, _ := s.zbx.TriggerTargets(ctx, tids)
	hiddenHosts, _ := s.st.ActiveSuppressions(ctx, "hide", "host")
	hiddenItems, _ := s.st.ActiveSuppressions(ctx, "hide", "item")
	acked, _ := s.st.ActiveSuppressions(ctx, "ack", "event")

	out := make([]problemRow, 0, len(problems))
	for _, p := range problems {
		t, ok := targets[p.ObjectID]
		if !ok || len(t.Hosts) == 0 {
			continue // can't attribute to a host; skip
		}
		h := t.Hosts[0]
		if hiddenHosts[h.HostID] || h.Status == "1" { // host hidden or paused (disabled)
			continue
		}
		// Skip if the trigger's sensors are all hidden in Argus.
		if len(t.Items) > 0 {
			allHidden := true
			for _, it := range t.Items {
				if !hiddenItems[it.ItemID] {
					allHidden = false
					break
				}
			}
			if allHidden {
				continue
			}
		}
		sev := atoi(p.Severity)
		out = append(out, problemRow{
			EventID:      p.EventID,
			Name:         p.Name,
			HostID:       h.HostID,
			HostName:     h.Name,
			Severity:     sev,
			State:        severityState(sev),
			Acknowledged: acked[p.EventID],
			Clock:        atoi64(p.Clock),
		})
	}
	writeJSON(w, http.StatusOK, out)
}
