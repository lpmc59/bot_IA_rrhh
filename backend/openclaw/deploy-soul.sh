#!/usr/bin/env bash
# deploy-soul.sh — Sincroniza el SOUL.md del repo a las 2 ubicaciones que
# OpenClaw lee (~/.openclaw/SOUL.md y ~/.openclaw/workspace/SOUL.md).
#
# OpenClaw NO lee el SOUL.md desde el repo. Hay 3 ubicaciones distintas y
# todas tienen que coincidir; si solo se actualiza una, el agente sigue
# operando con el prompt viejo en cualquiera de las otras dos.
#
# Uso típico (después de `git pull` en el server):
#   bash backend/openclaw/deploy-soul.sh
#
# Flags:
#   --no-restart   No reinicia openclaw-gateway al final (default: lo reinicia)
#   --dry-run      Muestra qué haría sin tocar nada
#
# Requiere: bash, md5sum, cp, systemctl (para el restart). Funciona como user
# (no necesita sudo) — los 3 paths viven en el home del user que corre el bot.

set -euo pipefail

# ─── Resolver paths ─────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/SOUL.md"
DEST1="${HOME}/.openclaw/SOUL.md"
DEST2="${HOME}/.openclaw/workspace/SOUL.md"
TS="$(date +%Y%m%d-%H%M%S)"

DRY_RUN=0
DO_RESTART=1
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --no-restart) DO_RESTART=0 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Argumento no reconocido: $arg" >&2; exit 2 ;;
  esac
done

# ─── Helpers ────────────────────────────────────────────────────────────────

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
hash_of() { md5sum "$1" 2>/dev/null | awk '{print $1}'; }

# ─── Pre-checks ─────────────────────────────────────────────────────────────

if [[ ! -f "$SRC" ]]; then
  red "ERROR: source SOUL.md no encontrado en: $SRC"
  exit 1
fi

# Crear ~/.openclaw/workspace si no existe (poco común pero defensivo)
mkdir -p "$(dirname "$DEST1")" "$(dirname "$DEST2")"

# ─── Comparación inicial ────────────────────────────────────────────────────

H_SRC="$(hash_of "$SRC")"
H_D1="$(hash_of "$DEST1" || true)"
H_D2="$(hash_of "$DEST2" || true)"

echo "─── md5 actual ──────────────────────────────"
printf "  source : %s  %s\n" "${H_SRC:-<none>}" "$SRC"
printf "  dest 1 : %s  %s\n" "${H_D1:-<none>}" "$DEST1"
printf "  dest 2 : %s  %s\n" "${H_D2:-<none>}" "$DEST2"
echo

if [[ "$H_SRC" == "$H_D1" && "$H_SRC" == "$H_D2" ]]; then
  green "✓ Los 3 SOUL.md ya están sincronizados — nada que hacer."
  if [[ "$DO_RESTART" -eq 1 ]]; then
    yellow "  (Saltando restart — no había nada que recargar.)"
  fi
  exit 0
fi

# ─── Aplicar (o dry-run) ────────────────────────────────────────────────────

if [[ "$DRY_RUN" -eq 1 ]]; then
  yellow "DRY RUN — los siguientes archivos cambiarían:"
  [[ "$H_D1" != "$H_SRC" ]] && echo "  • $DEST1  ($H_D1 → $H_SRC)"
  [[ "$H_D2" != "$H_SRC" ]] && echo "  • $DEST2  ($H_D2 → $H_SRC)"
  echo
  yellow "(Re-correr sin --dry-run para aplicar.)"
  exit 0
fi

echo "─── Aplicando ───────────────────────────────"
if [[ "$H_D1" != "$H_SRC" ]]; then
  if [[ -f "$DEST1" ]]; then
    cp "$DEST1" "${DEST1}.bak-${TS}"
    echo "  • backup: ${DEST1}.bak-${TS}"
  fi
  cp "$SRC" "$DEST1"
  green "  ✓ actualizado: $DEST1"
fi

if [[ "$H_D2" != "$H_SRC" ]]; then
  if [[ -f "$DEST2" ]]; then
    cp "$DEST2" "${DEST2}.bak-${TS}"
    echo "  • backup: ${DEST2}.bak-${TS}"
  fi
  cp "$SRC" "$DEST2"
  green "  ✓ actualizado: $DEST2"
fi

# ─── Verificación final ─────────────────────────────────────────────────────

H_D1="$(hash_of "$DEST1")"
H_D2="$(hash_of "$DEST2")"

echo
echo "─── md5 final ───────────────────────────────"
printf "  source : %s\n" "$H_SRC"
printf "  dest 1 : %s%s\n" "$H_D1" "$([[ "$H_D1" == "$H_SRC" ]] && echo '  ✓' || echo '  ✗')"
printf "  dest 2 : %s%s\n" "$H_D2" "$([[ "$H_D2" == "$H_SRC" ]] && echo '  ✓' || echo '  ✗')"

if [[ "$H_D1" != "$H_SRC" || "$H_D2" != "$H_SRC" ]]; then
  red "✗ Algo falló — los hashes no coinciden tras la copia."
  exit 1
fi

# ─── Restart OpenClaw para que recargue el prompt ───────────────────────────

if [[ "$DO_RESTART" -eq 1 ]]; then
  echo
  echo "─── Reiniciando openclaw-gateway ────────────"
  if systemctl --user is-active --quiet openclaw-gateway.service 2>/dev/null; then
    systemctl --user restart openclaw-gateway.service
    sleep 12
    if journalctl --user -u openclaw-gateway.service --since "20 sec ago" --no-pager 2>/dev/null \
         | grep -qE 'agent model|starting provider'; then
      green "  ✓ openclaw-gateway reiniciado y operativo."
    else
      yellow "  ! restart enviado pero no detecté los logs esperados — verificá manualmente:"
      yellow "    journalctl --user -u openclaw-gateway.service -n 30 --no-pager"
    fi
  else
    yellow "  ! openclaw-gateway.service no está activo (o no es systemd-user)."
    yellow "    Reiniciá manualmente con el método que uses: systemctl --user restart openclaw-gateway.service"
  fi
fi

green
green "✓ SOUL.md sincronizado en las 3 ubicaciones."
