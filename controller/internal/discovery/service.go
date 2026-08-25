package discovery

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

type Service struct {
	verifier *Verifier
	key      []byte
	conn     *net.UDPConn
	onDevice func(Response)
	done     chan struct{}
	wg       sync.WaitGroup
}

func NewService(key []byte, onDevice func(Response)) *Service {
	return &Service{verifier: NewVerifier(key, 10*time.Second), key: append([]byte(nil), key...), onDevice: onDevice, done: make(chan struct{})}
}

func (s *Service) Start() error {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: Port})
	if err != nil {
		return fmt.Errorf("启动 UDP 发现失败: %w", err)
	}
	s.conn = conn
	s.wg.Add(2)
	go s.broadcastLoop()
	go s.readLoop()
	return nil
}

func (s *Service) Close() error {
	select {
	case <-s.done:
	default:
		close(s.done)
	}
	var err error
	if s.conn != nil {
		err = s.conn.Close()
	}
	s.wg.Wait()
	return err
}

func (s *Service) broadcastLoop() {
	defer s.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		s.broadcast()
		select {
		case <-ticker.C:
		case <-s.done:
			return
		}
	}
}

func (s *Service) broadcast() {
	request := s.verifier.NewRequest(time.Now())
	payload, _ := json.Marshal(request)
	for _, address := range broadcastAddresses() {
		if _, err := s.conn.WriteToUDP(payload, &net.UDPAddr{IP: address, Port: Port}); err != nil {
			log.Printf("UDP 发现广播失败 %s: %v", address, err)
		}
	}
}

func (s *Service) readLoop() {
	defer s.wg.Done()
	buffer := make([]byte, 1400)
	for {
		n, remote, err := s.conn.ReadFromUDP(buffer)
		if err != nil {
			select {
			case <-s.done:
				return
			default:
				log.Printf("UDP 发现读取失败: %v", err)
				return
			}
		}
		var announcement Announcement
		if json.Unmarshal(buffer[:n], &announcement) == nil && s.verifier.AcceptAnnouncement(announcement, time.Now()) {
			offer, offerErr := NewOffer(s.key, announcement, 8081)
			if offerErr == nil {
				if payload, marshalErr := json.Marshal(offer); marshalErr == nil {
					_, _ = s.conn.WriteToUDP(payload, remote)
				}
			}
			continue
		}
		var response Response
		if json.Unmarshal(buffer[:n], &response) != nil || !s.verifier.Accept(response, time.Now()) {
			continue
		}
		if s.onDevice != nil {
			s.onDevice(response)
		}
	}
}

func broadcastAddresses() []net.IP {
	interfaces, _ := net.Interfaces()
	result := make([]net.IP, 0)
	seen := make(map[string]bool)
	for _, item := range interfaces {
		if item.Flags&net.FlagUp == 0 || item.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, _ := item.Addrs()
		for _, address := range addresses {
			network, ok := address.(*net.IPNet)
			if !ok {
				continue
			}
			ip := network.IP.To4()
			if ip == nil || len(network.Mask) != 4 {
				continue
			}
			broadcast := make(net.IP, 4)
			for index := range broadcast {
				broadcast[index] = ip[index] | ^network.Mask[index]
			}
			key := broadcast.String()
			if !seen[key] {
				seen[key] = true
				result = append(result, broadcast)
			}
		}
	}
	return result
}
