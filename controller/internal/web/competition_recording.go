package web

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type competitionRecordingResult struct {
	Active        bool    `json:"active"`
	RecordingID   string  `json:"recordingId"`
	FileName      string  `json:"fileName"`
	StartedAt     string  `json:"startedAt"`
	DurationMs    int64   `json:"durationMs"`
	FrameCount    int64   `json:"frameCount"`
	DroppedFrames int64   `json:"droppedFrames"`
	AverageFPS    float64 `json:"averageFps"`
	Width         int     `json:"width"`
	Height        int     `json:"height"`
	View          string  `json:"view"`
	Transform     string  `json:"transform"`
	Error         string  `json:"error"`
}

type competitionRecordingEnvelope struct {
	Recording competitionRecordingResult `json:"recording"`
	Message   string                     `json:"message"`
}

func (s *server) callVisionRecording(
	ctx context.Context,
	method string,
	path string,
	payload any,
) (competitionRecordingResult, error) {
	if strings.TrimSpace(s.visionAPIAddress) == "" {
		return competitionRecordingResult{}, fmt.Errorf("视觉服务地址未配置")
	}
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return competitionRecordingResult{}, err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		s.visionAPIAddress+path,
		body,
	)
	if err != nil {
		return competitionRecordingResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	client := s.visionHTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return competitionRecordingResult{}, fmt.Errorf("无法连接视觉录像服务: %w", err)
	}
	defer response.Body.Close()
	var envelope competitionRecordingEnvelope
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		return competitionRecordingResult{}, fmt.Errorf("录像服务响应无效: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := strings.TrimSpace(envelope.Message)
		if message == "" {
			message = response.Status
		}
		return competitionRecordingResult{}, fmt.Errorf("%s", message)
	}
	return envelope.Recording, nil
}

func (s *server) startCompetitionRecording(
	ctx context.Context,
	match *competitionMatch,
) (competitionRecordingResult, error) {
	return s.callVisionRecording(ctx, http.MethodPost, "/recordings", map[string]any{
		"recordingId": match.ID,
		"matchNo":     match.MatchNo,
		"group":       match.Group,
		"venue":       match.Venue,
		"blueName":    match.Blue.Name,
		"redName":     match.Red.Name,
	})
}

func (s *server) stopCompetitionRecording(
	ctx context.Context,
	recordingID string,
	discard bool,
) (competitionRecordingResult, error) {
	path := "/recordings/" + url.PathEscape(recordingID)
	if discard {
		path += "?discard=true"
	}
	return s.callVisionRecording(ctx, http.MethodDelete, path, nil)
}

func recordingPlaybackURL(fileName string) string {
	if strings.TrimSpace(fileName) == "" {
		return ""
	}
	return "/api/vision/recordings/files/" + url.PathEscape(fileName)
}
