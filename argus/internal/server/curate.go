package server

import "strings"

// Curation maps raw Zabbix item keys to a small set of sensor categories the user cares
// about (ping, CPU, memory, disk, …) with friendly labels. Items that don't match a rule
// are considered "noise" and hidden unless the caller asks for the full list.
//
// Matching is by the item key's base (the part before the first "[") plus its parameters,
// which keeps multi-instance sensors (per-mount disk, per-interface network) distinct.

// categoryOrder controls how categories are grouped/sorted in the curated view.
var categoryOrder = map[string]int{
	"Ping":        0,
	"CPU":         1,
	"Memory":      2,
	"Disk":        3,
	"Network":     4,
	"Temperature": 5,
	"Uptime":      6,
}

// splitKey returns the base key and its parameters, e.g. vfs.fs.size[/,pused] ->
// ("vfs.fs.size", ["/", "pused"]).
func splitKey(key string) (string, []string) {
	i := strings.IndexByte(key, '[')
	if i < 0 {
		return key, nil
	}
	base := key[:i]
	inner := strings.TrimSuffix(key[i+1:], "]")
	parts := strings.Split(inner, ",")
	for j := range parts {
		parts[j] = strings.Trim(strings.TrimSpace(parts[j]), `"`)
	}
	return base, parts
}

func param(params []string, i int) string {
	if i < len(params) {
		return params[i]
	}
	return ""
}

// classifyItem returns (category, label, matched) for a Zabbix item key/name.
func classifyItem(key, name string) (string, string, bool) {
	base, p := splitKey(key)

	switch base {
	case "icmpping":
		return "Ping", "Reachable (ICMP)", true
	case "icmppingloss":
		return "Ping", "ICMP loss", true
	case "icmppingsec":
		return "Ping", "ICMP response time", true

	case "system.cpu.util":
		return "CPU", "CPU utilization", true
	case "system.cpu.load":
		if a := param(p, 1); a != "" {
			return "CPU", "CPU load (" + a + ")", true
		}
		return "CPU", "CPU load", true

	case "vm.memory.utilization":
		return "Memory", "Memory utilization", true
	case "vm.memory.size", "vm.memory.dependent.size":
		switch param(p, 0) {
		case "pavailable":
			return "Memory", "Available memory %", true
		case "available":
			return "Memory", "Available memory", true
		case "pused":
			return "Memory", "Used memory %", true
		case "used":
			return "Memory", "Used memory", true
		case "total":
			return "Memory", "Total memory", true
		}

	case "vfs.fs.size", "vfs.fs.dependent.size":
		mount := param(p, 0)
		switch param(p, 1) {
		case "pused":
			return "Disk", "Disk used % (" + mount + ")", true
		case "used":
			return "Disk", "Disk used (" + mount + ")", true
		case "total":
			return "Disk", "Disk total (" + mount + ")", true
		case "pfree":
			return "Disk", "Disk free % (" + mount + ")", true
		case "free":
			return "Disk", "Disk free (" + mount + ")", true
		}

	case "net.if.in", "net.if.dependent.in":
		if i := param(p, 0); i != "" {
			return "Network", "Traffic in (" + i + ")", true
		}
		return "Network", "Traffic in", true
	case "net.if.out", "net.if.dependent.out":
		if i := param(p, 0); i != "" {
			return "Network", "Traffic out (" + i + ")", true
		}
		return "Network", "Traffic out", true

	case "system.uptime":
		return "Uptime", "Uptime", true
	}

	// Heuristic fallback for temperature sensors, whose keys vary widely by template/SNMP.
	low := strings.ToLower(name)
	if strings.Contains(low, "temperature") || strings.Contains(low, " temp") {
		return "Temperature", name, true
	}
	return "", "", false
}
