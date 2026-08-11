package config

import (
	"os"
	"path/filepath"
	"strconv"
)

// Config holds runtime configuration, all sourced from environment variables so the
// container is configured purely via `docker run -e ...` / --env-file.
type Config struct {
	Listen        string // ARGUS_LISTEN, e.g. ":8080"
	ZabbixAPIURL  string // ARGUS_ZABBIX_API_URL
	DataDir       string // ARGUS_DATA_DIR, SQLite + CA store live here (mounted volume)
	AdminEmail    string // ARGUS_ADMIN_EMAIL, used once to seed the first admin
	AdminPassword string // ARGUS_ADMIN_PASSWORD, used once to seed the first admin
	CookieSecure  bool   // ARGUS_COOKIE_SECURE, set true when served over HTTPS
}

func Load() Config {
	return Config{
		Listen:        env("ARGUS_LISTEN", ":8080"),
		ZabbixAPIURL:  env("ARGUS_ZABBIX_API_URL", ""),
		DataDir:       env("ARGUS_DATA_DIR", "/data"),
		AdminEmail:    env("ARGUS_ADMIN_EMAIL", ""),
		AdminPassword: env("ARGUS_ADMIN_PASSWORD", ""),
		CookieSecure:  envBool("ARGUS_COOKIE_SECURE", false),
	}
}

// DBPath is the SQLite database file location inside the data volume.
func (c Config) DBPath() string { return filepath.Join(c.DataDir, "argus.db") }

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}
