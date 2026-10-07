---
type: Vector Index
title: Semantic Vector Index
resource: ../../data/qdrant
model: nvidia/nemotron-3-embed-1b
dimension: 2048
build_status: optional
---

# Semantic Vector Index

The local Qdrant store is referenced at `../../data/qdrant`. It is queried
lazily when a compatible completed index is available.
