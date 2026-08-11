package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"argus/internal/auth"
	"argus/internal/config"
	"argus/internal/store"
	"argus/internal/zabbix"
	"argus/web"
)

const sessionTTL = 7 * 24 * time.Hour

type Server struct {
	cfg       config.Config
	zbx       *zabbix.Client
	st        *store.Store
	logger    *slog.Logger
	dummyHash string // for constant-ish login timing when a user doesn't exist
}

func New(cfg config.Config, zbx *zabbix.Client, st *store.Store, logger *slog.Logger) http.Handler {
	dummy, _ := auth.HashPassword("argus-nonexistent-user")
	s := &Server{cfg: cfg, zbx: zbx, st: st, logger: logger, dummyHash: dummy}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /api/health", s.handleAPIHealth)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", auth.RequireAuth(s.handleMe))
	mux.HandleFunc("POST /api/me/password", auth.RequireAuth(s.handleChangeOwnPassword))

	// user management (admin only)
	mux.HandleFunc("GET /api/users", auth.RequireRole("admin", s.handleListUsers))
	mux.HandleFunc("POST /api/users", auth.RequireRole("admin", s.handleCreateUser))
	mux.HandleFunc("PATCH /api/users/{id}", auth.RequireRole("admin", s.handleUpdateUser))
	mux.HandleFunc("DELETE /api/users/{id}", auth.RequireRole("admin", s.handleDeleteUser))
	mux.HandleFunc("POST /api/users/{id}/password", auth.RequireRole("admin", s.handleResetPassword))

	mux.Handle("/", spaHandler())

	// Every request passes through session resolution first.
	return auth.Middleware(s.st)(mux)
}

// --- health ---

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

// --- auth ---

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type userResponse struct {
	Email   string `json:"email"`
	Name    string `json:"name"`
	Surname string `json:"surname"`
	Role    string `json:"role"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	u, err := s.st.UserByEmail(r.Context(), req.Email)
	if err != nil {
		_, _ = auth.VerifyPassword(req.Password, s.dummyHash) // equalize timing
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	ok, err := auth.VerifyPassword(req.Password, u.PasswordHash)
	if err != nil || !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	raw, id, err := auth.NewSessionToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if err := s.st.CreateSession(r.Context(), id, u.ID, time.Now().Add(sessionTTL)); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	auth.SetSessionCookie(w, raw, s.cfg.CookieSecure, sessionTTL)
	writeJSON(w, http.StatusOK, userResponse{Email: u.Email, Name: u.Name, Surname: u.Surname, Role: u.Role})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.CookieName); err == nil && c.Value != "" {
		_ = s.st.DeleteSession(r.Context(), auth.HashToken(c.Value))
	}
	auth.ClearSessionCookie(w, s.cfg.CookieSecure)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u, _ := auth.UserFrom(r.Context()) // guaranteed present by RequireAuth
	writeJSON(w, http.StatusOK, userResponse{Email: u.Email, Name: u.Name, Surname: u.Surname, Role: u.Role})
}

// --- helpers / static ---

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func spaHandler() http.Handler {
	sub, _ := fs.Sub(web.Dist, "dist")
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.ServeFileFS(w, r, sub, "index.html")
			return
		}
		name := r.URL.Path[1:]
		if _, err := fs.Stat(sub, name); err != nil {
			http.ServeFileFS(w, r, sub, "index.html")
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
