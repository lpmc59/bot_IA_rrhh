#!/bin/bash
# ============================================================================
# TALINDA - Script de instalación de OpenClaw + Backend
# Servidor: Ubuntu 20.04 LTS
# ============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

echo ""
echo "============================================="
echo "  TALINDA - Instalación OpenClaw + Backend"
echo "============================================="
echo ""

# ─── 1. Verificar sistema ────────────────────────────────────────────────────

info "Verificando sistema..."
if ! command -v lsb_release &>/dev/null; then
    err "Este script es para Ubuntu. lsb_release no encontrado."
    exit 1
fi

OS_VERSION=$(lsb_release -rs)
info "Ubuntu $OS_VERSION detectado"

# ─── 2. Actualizar sistema ───────────────────────────────────────────────────

info "Actualizando sistema..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ─── 3. Instalar dependencias base ───────────────────────────────────────────

info "Instalando dependencias base..."
sudo apt-get install -y -qq curl git build-essential

# ─── 4. Instalar Node.js 22 ──────────────────────────────────────────────────

if command -v node &>/dev/null; then
    NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge 22 ]; then
        log "Node.js $(node --version) ya instalado"
    else
        warn "Node.js $(node --version) es menor a v22, actualizando..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y -qq nodejs
    fi
else
    info "Instalando Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi

log "Node.js $(node --version) | npm $(npm --version)"

# ─── 5. Instalar OpenClaw ────────────────────────────────────────────────────

info "Instalando OpenClaw..."
if command -v openclaw &>/dev/null; then
    log "OpenClaw ya instalado, actualizando..."
    sudo npm install -g openclaw@latest
else
    sudo npm install -g openclaw@latest
fi

log "OpenClaw instalado: $(openclaw --version 2>/dev/null || echo 'OK')"

# ─── 6. Crear directorios del proyecto ───────────────────────────────────────

INSTALL_DIR="/home/talinda_openclaw"
BACKEND_DIR="$INSTALL_DIR/backend"

info "Creando directorios en $INSTALL_DIR..."
sudo mkdir -p "$BACKEND_DIR"
sudo mkdir -p "$INSTALL_DIR/uploads"
sudo mkdir -p "$INSTALL_DIR/logs"

# ─── 7. Copiar backend ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$SCRIPT_DIR/package.json" ]; then
    info "Copiando backend al servidor..."
    sudo cp -r "$SCRIPT_DIR"/* "$BACKEND_DIR/"
    sudo cp "$SCRIPT_DIR/.env" "$BACKEND_DIR/.env" 2>/dev/null || true
fi

# ─── 8. Instalar dependencias del backend ────────────────────────────────────

info "Instalando dependencias del backend..."
cd "$BACKEND_DIR"
sudo npm install --production

# ─── 9. Crear servicio systemd para el backend ──────────────────────────────

info "Creando servicio systemd para el backend..."

sudo tee /etc/systemd/system/talinda-backend.service > /dev/null <<EOF
[Unit]
Description=TALINDA OpenClaw Backend
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=$BACKEND_DIR
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable talinda-backend.service
log "Servicio talinda-backend creado"

# ─── 10. Instrucciones finales ───────────────────────────────────────────────

echo ""
echo "============================================="
echo "  INSTALACIÓN COMPLETADA"
echo "============================================="
echo ""
log "OpenClaw instalado globalmente"
log "Backend instalado en: $BACKEND_DIR"
echo ""
echo "SIGUIENTES PASOS:"
echo ""
echo "  1. Configurar OpenClaw (primera vez):"
echo "     ${BLUE}openclaw onboard --install-daemon${NC}"
echo ""
echo "  2. Conectar WhatsApp:"
echo "     ${BLUE}openclaw channels login --channel whatsapp${NC}"
echo "     (Escanear QR code con WhatsApp)"
echo ""
echo "  3. Editar configuración del backend:"
echo "     ${BLUE}sudo nano $BACKEND_DIR/.env${NC}"
echo "     - Colocar tu ANTHROPIC_API_KEY"
echo "     - Verificar datos de DB"
echo "     - Colocar OPENCLAW_GATEWAY_TOKEN"
echo ""
echo "  4. Iniciar el backend:"
echo "     ${BLUE}sudo systemctl start talinda-backend${NC}"
echo ""
echo "  5. Verificar que funciona:"
echo "     ${BLUE}curl http://localhost:3000/webhook/health${NC}"
echo ""
echo "  6. Configurar el hook de OpenClaw:"
echo "     Ver archivo: $BACKEND_DIR/openclaw/openclaw-hook-config.md"
echo ""
echo "  7. Logs del backend:"
echo "     ${BLUE}sudo journalctl -u talinda-backend -f${NC}"
echo ""
