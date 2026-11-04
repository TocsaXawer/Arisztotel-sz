#!/bin/zsh
# Arisztotelész indító – Terminálból: ./start.command   Finderből: dupla kattintás
# Leállítás: Ctrl+C ebben az ablakban.

# ---------- beállítások ----------
PORT=${PORT:-5577}                                   # a program webcíme: http://localhost:$PORT
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}" # az Ollama címe
OPEN_BROWSER=${OPEN_BROWSER:-1}                      # 1 = indításkor megnyitja a böngészőt
KEEP_AWAKE=${KEEP_AWAKE:-1}                          # 1 = amíg fut, a Mac nem alszik el (hosszú könyvíráshoz)
# ---------------------------------

cd "${0:A:h}" || exit 1
# Finderből indítva szűk a PATH, ezért hozzáadjuk a Homebrew-t is
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PORT OLLAMA_HOST
URL="http://localhost:$PORT"

echo "📖 Arisztotelész indítása…"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Nem található a Node.js. Telepítsd: brew install node  (vagy https://nodejs.org)"
  read -k 1 "?Nyomj meg egy gombot a bezáráshoz…"; exit 1
fi

# Ollama: ha nem fut, elindítjuk és megvárjuk
if ! curl -s --max-time 2 "$OLLAMA_HOST/api/version" >/dev/null; then
  echo "⏳ Az Ollama nem fut – indítom…"
  if [[ -d /Applications/Ollama.app ]]; then
    open -a Ollama
  elif command -v ollama >/dev/null 2>&1; then
    nohup ollama serve >/dev/null 2>&1 &
  fi
  for i in {1..30}; do
    curl -s --max-time 2 "$OLLAMA_HOST/api/version" >/dev/null && break
    sleep 1
  done
fi
if curl -s --max-time 2 "$OLLAMA_HOST/api/version" >/dev/null; then
  echo "✅ Ollama fut ($OLLAMA_HOST)"
else
  echo "⚠️  Az Ollama nem érhető el ($OLLAMA_HOST) – a program elindul, de írni csak akkor tud, ha az Ollama fut."
fi

# Ha a program már fut ezen a porton, csak megnyitjuk
if curl -s --max-time 2 "$URL/api/projects" >/dev/null; then
  echo "ℹ️  Az Arisztotelész már fut: $URL"
  [[ $OPEN_BROWSER == 1 ]] && open "$URL"
  exit 0
fi

# Böngésző megnyitása, amint a szerver válaszol
if [[ $OPEN_BROWSER == 1 ]]; then
  ( for i in {1..30}; do
      curl -s --max-time 1 "$URL/api/projects" >/dev/null && { open "$URL"; break; }
      sleep 0.5
    done ) &
fi

echo "🚀 Indul: $URL   (leállítás: Ctrl+C)"
# a caffeinate addig tartja ébren a gépet, amíg ez a folyamat (az exec után maga a node) fut
[[ $KEEP_AWAKE == 1 ]] && caffeinate -is -w $$ &
exec node server.js
