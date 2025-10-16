#!/bin/bash

# Script para build do Docker com SSH Agent
# Salve como: build.sh

set -e  # Parar em caso de erro

echo "🔑 Iniciando SSH Agent..."
eval $(ssh-agent -s)

echo "🔐 Adicionando chave SSH (você precisará digitar a senha)..."
ssh-add ~/.ssh/id_ed25519

echo "🐳 Fazendo build da imagem Docker..."
export DOCKER_BUILDKIT=1
docker build --ssh default -t uno/evolution .

echo "✅ Build concluído com sucesso!"
echo ""
echo "🧹 Limpando SSH Agent..."
ssh-agent -k

echo "🎉 Pronto! Imagem criada: uno/evolution-test"