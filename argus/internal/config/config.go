package config

import "os"

// Config holds runtime configuration, all sourced from environment variables so the
// container is configured purely via `docker run -e ...` / --env-file.
type Config struct {
	Listen       string // ARGUS_LISTEN, e.g. ":8080"
	ZabbixAPIURL string // ARGUS_ZABBIX_API_URL, e.g. "http://10.0.0.10:8080/api_jsonrpc.php"
	DataDir      string // ARGUS_DATA_DIR, SQLite + CA store live here (mounted volume)
}

func Load() Config {
	return Config{
		Listen:       env("ARGUS_LISTEN", ":8080"),
		ZabbixAPIURL: env("ARGUS_ZABBIX_API_URL", ""),
		DataDir:      env("ARGUS_DATA_DIR", "/data"),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
