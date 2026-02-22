ffmpeg -i input.mp4 -vf "scale=120:40:flags=lanczos,fps=15,format=gray" -c:v libx264 -preset medium -crf 20 -an -pix_fmt yuv420p test.mp4
