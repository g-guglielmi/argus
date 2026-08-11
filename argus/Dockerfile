# syntax=docker/dockerfile:1

# ---- Stage 1: build the React frontend ----
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build          # outputs to /web/dist

# ---- Stage 2: build the Go binary (embeds the frontend) ----
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
# overwrite the placeholder dist with the freshly built assets so go:embed bakes them in
COPY --from=web /web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /argus .

# ---- Stage 3: minimal runtime ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /argus /argus
ENV ARGUS_LISTEN=":8080" ARGUS_DATA_DIR="/data"
EXPOSE 8080
VOLUME ["/data"]
USER nonroot:nonroot
ENTRYPOINT ["/argus"]
