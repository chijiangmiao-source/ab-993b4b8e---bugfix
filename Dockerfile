# 离线探测清单三副本演练 —— 零依赖 Node 20 镜像
FROM node:20-alpine

WORKDIR /app

# 仅复制清单与源码（见 .dockerignore），无第三方依赖，无需 npm install
COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY scripts ./scripts
COPY verify ./verify
RUN chmod +x ./verify

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
