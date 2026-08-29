#!/bin/bash
set -e

DOMAIN="rag.luxuryhorizon.lat"
EMAIL="ederb1.1c@gmail.com"

echo "==> Parando contenedores existentes..."
docker compose down 2>/dev/null || true

echo "==> Creando directorios..."
mkdir -p certbot/conf certbot/www

echo "==> Obteniendo certificado SSL para $DOMAIN..."
docker run --rm \
  -p 80:80 \
  -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/certbot/www:/var/www/certbot" \
  certbot/certbot certonly \
  --standalone \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN"

echo "==> Iniciando con HTTPS..."
docker compose up -d --build

echo ""
echo "Listo! Visita https://$DOMAIN"
