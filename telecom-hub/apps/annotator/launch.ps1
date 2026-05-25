# $PSScriptRoot is set when run as a file; $env:ANNOTATOR_ROOT is the fallback
# when invoked via Invoke-Expression from the bat launcher (bypasses GPO AllSigned)
$root = if ($PSScriptRoot) { $PSScriptRoot } else { $env:ANNOTATOR_ROOT }
$port = 3004

# Find a free port starting at 3004
while ($true) {
    try {
        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add("http://localhost:$port/")
        $listener.Start()
        break
    } catch {
        $port++
        if ($port -gt 3020) { Write-Error "No free port found"; exit 1 }
    }
}

Start-Process "msedge" "--app=http://localhost:$port/"

Write-Host "Patent Figure Annotator running at http://localhost:$port/"
Write-Host "Close this window to stop the server."

$mimeMap = @{
    '.html'  = 'text/html; charset=utf-8'
    '.js'    = 'application/javascript; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.json'  = 'application/json'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.ico'   = 'image/x-icon'
    '.svg'   = 'image/svg+xml'
    '.woff2' = 'font/woff2'
    '.woff'  = 'font/woff'
    '.ttf'   = 'font/ttf'
    '.txt'   = 'text/plain'
}

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $urlPath = [System.Uri]::UnescapeDataString($context.Request.Url.LocalPath)

        if ($urlPath -eq '/' -or $urlPath -eq '') { $urlPath = '/index.html' }

        $filePath = Join-Path $root ($urlPath.TrimStart('/') -replace '/', [System.IO.Path]::DirectorySeparatorChar)

        try {
            if (Test-Path $filePath -PathType Leaf) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $ext   = [System.IO.Path]::GetExtension($filePath).ToLower()
                $mime  = if ($mimeMap.ContainsKey($ext)) { $mimeMap[$ext] } else { 'application/octet-stream' }
                $context.Response.ContentType      = $mime
                $context.Response.ContentLength64  = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                # SPA fallback
                $index = Join-Path $root 'index.html'
                $bytes = [System.IO.File]::ReadAllBytes($index)
                $context.Response.ContentType     = 'text/html; charset=utf-8'
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            $context.Response.StatusCode = 500
        }
        $context.Response.Close()
    } catch {
        break
    }
}
