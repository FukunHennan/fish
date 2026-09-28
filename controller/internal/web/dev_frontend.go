package web

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const developmentReloadScript = `<script>
(() => {
  let revision = "";
  const poll = async () => {
    try {
      const response = await fetch("/__dev/revision", { cache: "no-store" });
      if (response.ok) {
        const next = (await response.text()).trim();
        if (revision && next && next !== revision) location.reload();
        revision = next;
      }
    } catch (_) {}
    setTimeout(poll, 750);
  };
  poll();
})();
</script>`

func frontendHandler() http.Handler {
	if root := strings.TrimSpace(os.Getenv("FISH_FRONTEND_DIR")); root != "" {
		if info, err := os.Stat(filepath.Join(root, "competition.html")); err == nil && !info.IsDir() {
			return developmentFrontendHandler(root)
		}
	}
	staticFiles, err := fs.Sub(frontendFiles, "dist")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(staticFiles))
}

func developmentFrontendHandler(root string) http.Handler {
	root, err := filepath.Abs(root)
	if err != nil {
		panic(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		if r.URL.Path == "/__dev/revision" {
			revision, err := developmentFrontendRevision(root)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte(revision))
			return
		}

		path, ok := developmentFrontendPath(root, r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if strings.EqualFold(filepath.Ext(path), ".html") {
			body := string(data)
			if index := strings.LastIndex(strings.ToLower(body), "</body>"); index >= 0 {
				body = body[:index] + developmentReloadScript + body[index:]
			} else {
				body += developmentReloadScript
			}
			data = []byte(body)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		} else if contentType := mime.TypeByExtension(filepath.Ext(path)); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		info, err := os.Stat(path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		http.ServeContent(w, r, filepath.Base(path), info.ModTime(), strings.NewReader(string(data)))
	})
}

func developmentFrontendPath(root, requestPath string) (string, bool) {
	var relative string
	switch {
	case requestPath == "/competition.html":
		relative = "competition.html"
	case strings.HasPrefix(requestPath, "/competition/"):
		relative = filepath.Join("public", filepath.FromSlash(strings.TrimPrefix(requestPath, "/")))
	default:
		return "", false
	}
	path := filepath.Clean(filepath.Join(root, relative))
	if path != root && !strings.HasPrefix(path, root+string(os.PathSeparator)) {
		return "", false
	}
	return path, true
}

func developmentFrontendRevision(root string) (string, error) {
	hash := sha256.New()
	paths := []string{filepath.Join(root, "competition.html"), filepath.Join(root, "public", "competition")}
	for _, path := range paths {
		err := filepath.WalkDir(path, func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(root, current)
			if err != nil {
				return err
			}
			_, _ = fmt.Fprintf(hash, "%s\x00%d\x00%d\n", filepath.ToSlash(relative), info.Size(), info.ModTime().UnixNano())
			return nil
		})
		if err != nil {
			return "", err
		}
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}
