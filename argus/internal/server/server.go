package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"argus/internal/config"
	"argus/internal/zabbix"
	"argus/web"
)

type Server struct {
	cfg    config.Config
	zbx    *zabbix.Client
	logger *slog.Logger
}

// New wires up the HTTP routes: health endpoints + the embedded SPA.
func New(cfg config.Config, zbx *zabbix.Client, logger *slog.Logger) http.Handler {
	s := &Server{cfg: cfg, zbx: zbx, logger: logger}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)     // liveness (no deps)
	mux.HandleFunc("GET /api/health", s.handleAPIHealth) // readiness incl. Zabbix reachability
	mux.Handle("/", spaHandler())                        // embedded React SPA
	return mux
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

type healthResponse struct {
	Status string       `json:"status"`
	Zabbix zabbixHealth `json:"zabbix"`
}

type zabbixHealth struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (s *Server) handleAPIHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	resp := healthResponse{Status: "ok"}
	if ver, err := s.zbx.APIVersion(ctx); err != nil {
		resp.Zabbix = zabbixHealth{Reachable: false, Error: err.Error()}
	} else {
		resp.Zabbix = zabbixHealth{Reachable: true, Version: ver}
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// spaHandler serves the embedded frontend, falling back to index.html for any
// path that isn't a real asset (so client-side routing works).
func spaHandler() http.Handler {
	sub, _ := fs.Sub(web.Dist, "dist")
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFileFS(w, r, sub, "index.html")
			return
		}
		name := r.URL.Path[1:] // strip leading slash
		if _, err := fs.Stat(sub, name); err != nil {
			http.ServeFileFS(w, r, sub, "index.html") // SPA fallback
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
