# $PSScriptRoot is set when run as a file; fall back to env var when
# invoked via Invoke-Expression from launch.bat (bypasses GPO AllSigned).
$root = if ($PSScriptRoot) { $PSScriptRoot } else { $env:ANNOTATOR_ROOT }

# Support both layouts:
#   layout A (correct): launch.bat + index.html in the same folder
#   layout B (common mistake): launch.bat sits next to the out/ folder
if (-not (Test-Path (Join-Path $root 'index.html'))) {
    $candidate = Join-Path $root 'out'
    if (Test-Path (Join-Path $candidate 'index.html')) {
        $root = $candidate
    } else {
        Write-Error "Cannot find index.html under $root"
        Read-Host "Press Enter to exit"
        exit 1
    }
}

$port = 3004
while ($true) {
    try {
        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add("http://localhost:$port/")
        $listener.Start()
        break
    } catch {
        $port++
        if ($port -gt 3020) { Write-Error "No free port found"; Read-Host; exit 1 }
    }
}

Write-Host "Serving from : $root"
Write-Host "Annotator URL: http://localhost:$port/"
Write-Host "Close this window to stop the server."

Start-Process "msedge" "--app=http://localhost:$port/"

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

        # Use String.Replace (literal, not regex) to avoid backslash escape issues
        $rel      = $urlPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $filePath = Join-Path $root $rel

        try {
            if (Test-Path $filePath -PathType Leaf) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $ext   = [System.IO.Path]::GetExtension($filePath).ToLower()
                $mime  = if ($mimeMap.ContainsKey($ext)) { $mimeMap[$ext] } else { 'application/octet-stream' }
                $context.Response.ContentType     = $mime
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                # SPA fallback — serve index.html for any unmatched route
                $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root 'index.html'))
                $context.Response.ContentType     = 'text/html; charset=utf-8'
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            Write-Host "500 $urlPath — $_"
            $context.Response.StatusCode = 500
        }
        $context.Response.Close()
    } catch {
        break
    }
}
