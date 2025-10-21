#!/bin/bash

# Script para build do Docker com SSH Agent
# Uso: ./build.sh <nome-da-imagem>
# Exemplo: ./build.sh uno/evolution-test
# Exemplo: ./build.sh uno/evolution

set -e  # Parar em caso de erro

# Verificar se foi passado o nome da imagem
if [ -z "$1" ]; then
    echo "❌ Erro: Você precisa especificar o nome da imagem!"
    echo ""
    echo "Uso: ./build.sh <nome-da-imagem>"
    echo ""
    echo "Exemplos:"
    echo "  ./build.sh uno/evolution-test"
    echo "  ./build.sh uno/evolution"
    exit 1
fi

IMAGE_NAME=$1

echo "🔑 Iniciando SSH Agent..."
eval $(ssh-agent -s)

echo "🔐 Adicionando chave SSH (você precisará digitar a senha)..."
ssh-add ~/.ssh/id_ed25519

echo "🐳 Fazendo build da imagem: $IMAGE_NAME"
export DOCKER_BUILDKIT=1
docker build --ssh default -t "$IMAGE_NAME" .

echo "✅ Build concluído com sucesso!"
echo ""
echo "🧹 Limpando SSH Agent..."
ssh-agent -k

echo "🎉 Pronto! Imagem criada: $IMAGE_NAME"