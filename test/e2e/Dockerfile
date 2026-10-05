# E2E テストを Linux のコンテナで、仮想のディスプレイ（xvfb）を使って実行する。手元の画面にウィンドウを出さない。
# 使い方: npm run test:e2e:docker -- <full|smoke|readonly|all>
# プロジェクトはイメージに写すので、手元のフォルダには書き込まない。

FROM node:22-bookworm

# VSCode（Electron）が使うライブラリと、表示幅や見出しの高さを確かめるための日本語のフォント
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxkbfile1 libsecret-1-0 libdrm2 libxshmfence1 \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Electron は root では起動しないので、イメージにある node ユーザーで実行する
USER node
WORKDIR /home/node/hushmark

# 依存と VSCode のダウンロードは、それぞれ package-lock.json と vscode.mjs が変わったときだけやり直す
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node test/e2e/vscode.mjs test/e2e/sample.md test/e2e/
RUN node -e "import('./test/e2e/vscode.mjs').then((m) => m.downloadVSCode())"
# Docker の既定の制限では Chromium のサンドボックスが名前空間を作れないので、コンテナの中でだけ切る
# （開くのはテスト用の文書だけで、コンテナが隔離の境界になる）
ENV E2E_NO_SANDBOX=1

COPY --chown=node:node . .
ENTRYPOINT ["xvfb-run", "-a", "npm", "run", "test:e2e", "--"]
CMD ["all"]
