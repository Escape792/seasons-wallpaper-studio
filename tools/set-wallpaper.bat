@echo off
REM ============================================================
REM  一键设置动态壁纸（Windows）
REM  用法：set-wallpaper.bat out\valley-autumn.mp4
REM  依赖：Lively Wallpaper（开源免费）https://github.com/rocksdanister/lively
REM ============================================================
setlocal

set "VIDEO=%~1"
if "%VIDEO%"=="" (
  echo [错误] 请指定视频文件，例如：set-wallpaper.bat out\valley-autumn.mp4
  exit /b 1
)

if not exist "%VIDEO%" (
  echo [错误] 文件不存在：%VIDEO%
  exit /b 1
)

REM 尝试调用 Lively 的命令行工具（LivelyCommand）
where LivelyCommand.exe >nul 2>&1
if %errorlevel%==0 (
  echo [1/2] 正在通过 Lively 设为动态壁纸...
  LivelyCommand.exe set-wallpaper "%VIDEO%" silent
  echo [2/2] 完成。
  exit /b 0
)

REM 退回方案：仅用系统自带功能设置静态帧作为壁纸
echo [提示] 未检测到 LivelyWallpaper 的命令行工具。
echo        方案 A：安装 Lively Wallpaper 后重试（https://github.com/rocksdanister/lively）
echo        方案 B：已将视频首帧提取为静态壁纸。

set "TMP=%TEMP%\wp_frame.jpg"
node_modules\ffmpeg-static\ffmpeg.exe -y -i "%VIDEO%" -frames:v 1 -q:v 2 "%TMP%" >nul 2>&1
if exist "%TMP%" (
  powershell -NoProfile -Command ^
    "Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms;" ^
    "$img=[System.Drawing.Image]::FromFile('%TMP%');" ^
    "$b=New-Object System.Drawing.Bitmap($img.Width,$img.Height);" ^
    "$g=[System.Drawing.Graphics]::FromImage($b);" ^
    "$g.DrawImage($img,0,0);" ^
    "$b.Save(\"$env:USERPROFILE\\Pictures\\Wallpaper.jpg\",[System.Drawing.Imaging.ImageFormat]::Jpeg);" ^
    "$img.Dispose();"
  echo [2/2] 静态壁纸已保存到 %%USERPROFILE%%\Pictures\Wallpaper.jpg
) else (
  echo [错误] 无法提取首帧。
)
endlocal
