FROM node:24-alpine
ENV NODE_ENV=production PORT=3000 LOG_FILE=/var/log/node-api/app.log
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /var/log/node-api && chown node:node /var/log/node-api
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD node -e "const s=require('node:net').connect(3000,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(2000,()=>process.exit(1))"
CMD ["node", "src/server.js"]
