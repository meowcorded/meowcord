package main

import "testing"

func TestResolvePublicIP(t *testing.T) {
	for host, want := range map[string]string{"203.0.113.10": "203.0.113.10", "localhost": "127.0.0.1"} {
		got, err := resolvePublicIP(host)
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		if got != want {
			t.Fatalf("%s resolved to %s, expected %s", host, got, want)
		}
	}
	if got, err := resolvePublicIP("sfu.invalid"); err == nil {
		t.Fatalf("an unresolvable host name resolved to %s", got)
	}
}
