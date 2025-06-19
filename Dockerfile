FROM ghcr.io/cachix/devenv/devcontainer:main

WORKDIR /workspace

COPY . .

USER vscode

RUN devenv shell echo "Nix environment is ready"

EXPOSE 8000 5173

CMD ["devenv", "shell", "./start.sh"]
