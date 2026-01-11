FROM alpine:3.23

LABEL maintainer="Peter Dave Hello <hsu@peterdavehello.org>"
LABEL name="tor-socks-proxy"
LABEL version="latest"

RUN echo '@edge https://dl-cdn.alpinelinux.org/alpine/edge/community' >> /etc/apk/repositories && \
    echo '@edge https://dl-cdn.alpinelinux.org/alpine/edge/testing'   >> /etc/apk/repositories && \
    apk -U upgrade && \
    apk -v add tor@edge obfs4proxy@edge curl nodejs npm && \
    chmod 700 /var/lib/tor && \
    mkdir -p /var/lib/tor-instances && \
    chown -R tor:root /var/lib/tor-instances && \
    rm -rf /var/cache/apk/* && \
    tor --version
COPY --chown=tor:root torrc /etc/tor/

WORKDIR /app
COPY --chown=tor:root package.json /app/
COPY --chown=tor:root package-lock.json /app/
COPY --chown=tor:root src /app/src

RUN npm ci --omit=dev --no-audit --no-fund
RUN chown -R tor:root /app

HEALTHCHECK --timeout=10s --start-period=180s \
    CMD curl --fail http://localhost:3128/__health && \
        curl --fail --socks5-hostname localhost:9150 -I -L 'https://www.facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfyd.onion/' || exit 1

USER tor
EXPOSE 8853/udp 9150/tcp 3128/tcp

CMD ["node", "src/index.js"]
