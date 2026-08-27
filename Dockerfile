FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY packages ./packages
COPY public ./public

ARG VITE_ENABLE_PRIVY
ARG VITE_PRIVY_APP_ID
ARG VITE_WALLETCONNECT_PROJECT_ID
ARG VITE_SETTLEMENT_CHAIN_ID
ARG VITE_USDC_CONTRACT_ADDRESS
ARG VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK
ENV VITE_ENABLE_PRIVY=$VITE_ENABLE_PRIVY \
    VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID \
    VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID \
    VITE_SETTLEMENT_CHAIN_ID=$VITE_SETTLEMENT_CHAIN_ID \
    VITE_USDC_CONTRACT_ADDRESS=$VITE_USDC_CONTRACT_ADDRESS \
    VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK=$VITE_ALLOW_DIRECT_POLYMARKET_FALLBACK

RUN npm run build

FROM node:22-alpine AS runtime-deps

WORKDIR /app

RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY server ./server
COPY packages ./packages
COPY src/marketData.ts src/types.ts ./src/

USER node
EXPOSE 8787

CMD ["npm", "run", "start:api"]
