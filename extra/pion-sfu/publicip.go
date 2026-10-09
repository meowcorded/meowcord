package main

import (
	"context"
	"fmt"
	"net"
	"time"
)

const publicIPLookupTimeout = 10 * time.Second

func resolvePublicIP(host string) (string, error) {
	if net.ParseIP(host) != nil {
		return host, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), publicIPLookupTimeout)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupIP(ctx, "ip4", host)
	if err != nil {
		return "", err
	}
	if len(addresses) == 0 {
		return "", fmt.Errorf("%s has no IPv4 address", host)
	}
	return addresses[0].String(), nil
}
