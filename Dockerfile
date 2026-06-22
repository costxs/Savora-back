FROM node:18-alpine

WORKDIR /app

RUN apk add --no-cache openssl

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies and generate Prisma client
RUN npm install

# Copy source code and Prisma schema
COPY . .

RUN npx prisma generate

# Build TypeScript
RUN npx tsc

EXPOSE 3001

CMD ["npm", "start"]
