// Package zabbix is a minimal client for the Zabbix JSON-RPC API.
// For the walking skeleton it only implements APIVersion (an unauthenticated
// connectivity check). Authenticated calls (login, host.get, history.get, ...)
// land in later Phase 1 slices.
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
	url  string
	http *http.Client
}

func New(url string) *Client {
	return &Client{
		url:  url,
		http: &http.Client{Timeout: 10 * time.Second},
	}
}

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

// APIVersion calls apiinfo.version, which requires no authentication.
// Used as the "can I reach Zabbix?" health probe.
func (c *Client) APIVersion(ctx context.Context) (string, error) {
	if c.url == "" {
		return "", fmt.Errorf("ARGUS_ZABBIX_API_URL is not set")
	}
	payload, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", Method: "apiinfo.version", Params: []any{}, ID: 1})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json-rpc")

	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected HTTP status %d from Zabbix API", resp.StatusCode)
	}

	var rr rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&rr); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if rr.Error != nil {
		return "", rr.Error
	}
	var version string
	if err := json.Unmarshal(rr.Result, &version); err != nil {
		return "", fmt.Errorf("unexpected result: %w", err)
	}
	return version, nil
}
