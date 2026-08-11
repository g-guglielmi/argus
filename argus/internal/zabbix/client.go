// Package zabbix is a minimal client for the Zabbix JSON-RPC API.
// APIVersion is an unauthenticated connectivity probe; the read methods
// (Hosts, Items, ActiveTriggers, …) authenticate with an API token.
package zabbix

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type Client struct {
	url   string
	token string
	http  *http.Client
}

func New(url, token string) *Client {
	return &Client{
		url:   url,
		token: token,
		http:  &http.Client{Timeout: 15 * time.Second},
	}
}

// Authenticated reports whether an API token is configured for read calls.
func (c *Client) Authenticated() bool { return c.token != "" }

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
	ID      int    `json:"id"`
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("zabbix rpc error %d: %s (%s)", e.Code, e.Message, e.Data)
}

// call performs a JSON-RPC request. When withAuth is true, the configured API
// token is sent as a Bearer header (Zabbix 7.0 style); out may be nil.
func (c *Client) call(ctx context.Context, method string, params any, withAuth bool, out any) error {
	if c.url == "" {
		return fmt.Errorf("ARGUS_ZABBIX_API_URL is not set")
	}
	if withAuth && c.token == "" {
		return fmt.Errorf("ARGUS_ZABBIX_API_TOKEN is not set")
	}
	payload, err := json.Marshal(rpcRequest{JSONRPC: "2.0", Method: method, Params: params, ID: 1})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json-rpc")
	if withAuth {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected HTTP status %d from Zabbix API", resp.StatusCode)
	}

	var rr rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&rr); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	if rr.Error != nil {
		return rr.Error
	}
	if out != nil {
		if err := json.Unmarshal(rr.Result, out); err != nil {
			return fmt.Errorf("unexpected result: %w", err)
		}
	}
	return nil
}

// APIVersion calls apiinfo.version (no auth). Used as the "can I reach Zabbix?" probe.
func (c *Client) APIVersion(ctx context.Context) (string, error) {
	var version string
	if err := c.call(ctx, "apiinfo.version", []any{}, false, &version); err != nil {
		return "", err
	}
	return version, nil
}

// --- read models ---

type Host struct {
	HostID string `json:"hostid"`
	Name   string `json:"name"`
	Status string `json:"status"` // "0" monitored, "1" not monitored
}

type Item struct {
	ItemID    string `json:"itemid"`
	HostID    string `json:"hostid"`
	Name      string `json:"name"`
	Key       string `json:"key_"`
	LastValue string `json:"lastvalue"`
	LastClock string `json:"lastclock"`
	Units     string `json:"units"`
	ValueType string `json:"value_type"`
	Status    string `json:"status"` // "0" enabled, "1" disabled
	State     string `json:"state"`  // "0" normal, "1" not supported
}

type Trigger struct {
	TriggerID string `json:"triggerid"`
	Priority  string `json:"priority"` // severity 0..5
	Value     string `json:"value"`    // "1" == problem
	Hosts     []struct {
		HostID string `json:"hostid"`
	} `json:"hosts"`
}

// Hosts returns all hosts, sorted by name.
func (c *Client) Hosts(ctx context.Context) ([]Host, error) {
	params := map[string]any{
		"output":    []string{"hostid", "name", "status"},
		"sortfield": "name",
	}
	var hosts []Host
	return hosts, c.call(ctx, "host.get", params, true, &hosts)
}

// Items returns the items of one host, sorted by name.
func (c *Client) Items(ctx context.Context, hostID string) ([]Item, error) {
	params := map[string]any{
		"output":    []string{"itemid", "hostid", "name", "key_", "lastvalue", "lastclock", "units", "value_type", "status", "state"},
		"hostids":   hostID,
		"sortfield": "name",
	}
	var items []Item
	return items, c.call(ctx, "item.get", params, true, &items)
}

// ActiveTriggers returns triggers currently in the problem state, with their host(s).
func (c *Client) ActiveTriggers(ctx context.Context) ([]Trigger, error) {
	params := map[string]any{
		"output":        []string{"triggerid", "priority", "value"},
		"selectHosts":   []string{"hostid"},
		"filter":        map[string]any{"value": 1},
		"monitored":     true,
		"skipDependent": true,
	}
	var triggers []Trigger
	return triggers, c.call(ctx, "trigger.get", params, true, &triggers)
}

type ProblemTrigger struct {
	Description string `json:"description"` // the trigger/problem name
	Priority    string `json:"priority"`    // severity 0..5
	Items       []struct {
		ItemID string `json:"itemid"`
	} `json:"items"`
}

// HostProblems returns the active problem triggers on one host, worst first, each with the
// item(s) it references so the UI can point at the offending sensor.
func (c *Client) HostProblems(ctx context.Context, hostID string) ([]ProblemTrigger, error) {
	params := map[string]any{
		"output":        []string{"description", "priority"},
		"selectItems":   []string{"itemid"},
		"hostids":       hostID,
		"filter":        map[string]any{"value": 1},
		"monitored":     true,
		"skipDependent": true,
		"sortfield":     "priority",
		"sortorder":     "DESC",
	}
	var triggers []ProblemTrigger
	return triggers, c.call(ctx, "trigger.get", params, true, &triggers)
}
