#!/bin/bash
cd "$(dirname "$0")"
pkill -f "[s]erve.py 8796" 2>/dev/null; sleep 1
echo "启动 一款大模型对话（本地版） :8796"
nohup python3 serve.py 8796 > server.log 2>&1 &
sleep 3
echo "打开浏览器: http://127.0.0.1:8796/"
