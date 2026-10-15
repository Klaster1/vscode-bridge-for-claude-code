# The image that runs `npm test`, the offline checks and the end-to-end test, on Linux under a
# virtual display. test/docker.ts builds it from the git-tracked files and runs it, locally and in CI.

FROM node:24-bookworm-slim

# Xvfb is the display. The libraries are the ones VS Code's Electron loads. git lists the tracked
# files for test/manifest-check.ts.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates git xauth xvfb \
		libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnss3 \
		libsecret-1-0 libxkbfile1 libxss1 \
	&& rm -rf /var/lib/apt/lists/*

# VS Code refuses to start as root without --no-sandbox.
USER node
WORKDIR /home/node/repo
RUN mkdir .vscode-test # A volume mounted here keeps this owner, and caches the VS Code download between runs.

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .
# The files come from a Windows checkout with CRLF line endings, or from a Linux one with LF. Git
# stores LF, so adding them with autocrlf=input and checking them out again gives every run the
# files a Linux CI checkout has.
RUN git init -q \
	&& git -c core.autocrlf=input add -A \
	&& git checkout-index --force --all

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1024x768x24", "npm", "test"]
