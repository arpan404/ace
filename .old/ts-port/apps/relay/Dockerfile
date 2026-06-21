FROM oven/bun:1.3.9

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 8788

CMD ["bun", "run", "src/server.ts"]
