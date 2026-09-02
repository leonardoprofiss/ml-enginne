#!/bin/sh
# Entrypoint de runtime: o volume persistente do Railway é montado em /data
# em tempo de execução (não em build), sempre pertencente a root. Como o
# processo Node roda como usuário não-root (node) por segurança, ajustamos a
# posse do diretório aqui — como root — antes de baixar o privilégio com
# gosu e executar o comando real.
set -e

if [ -d /data ]; then
  chown -R node:node /data
  fi

  exec gosu node "$@"
