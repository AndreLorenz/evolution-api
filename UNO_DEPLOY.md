Para fazer o deploy

Deve fazer o login no ECR

# Dar permissão de execução (só precisa fazer uma vez)
chmod +x build.sh

# Build de teste
./build.sh uno/evolution-test

# Build de produção
./build.sh uno/evolution