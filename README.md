# Pixel Place - Collaborative Canvas

Um aplicativo colaborativo de pixel art inspirado no r/place, construído com FastAPI e WebSockets.

## ✨ Funcionalidades

- **Canvas colaborativo** 2048x2048 pixels
- **Regiões otimizadas** - dividido em regiões 128x128 para performance
- **Chat regional** - converse com outros usuários na mesma região
- **Navegação suave** - carregamento automático de regiões adjacentes
- **Cooldown visual** - barra de progresso para próximo pixel
- **Proteção contra drag** - pixels só são colocados em cliques intencionais

## 🚀 Como rodar

### Opção 1: Usando uvicorn diretamente

```bash
# Instalar dependências
pip install -r requirements.txt

# Rodar servidor com auto-reload
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Opção 2: Usando o script Python

```bash
# Instalar dependências
pip install -r requirements.txt

# Rodar usando o script
python run.py
```

### Opção 3: Usando o ambiente virtual existente

```bash
# Rodar com o ambiente virtual configurado
/pioneira/docker/projetos/pxl/.venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## 🎮 Como usar

1. Abra `http://localhost:8000` no navegador
2. **Selecione uma cor** na paleta lateral
3. **Clique no canvas** para colocar pixels (cooldown de 5 segundos)
4. **Use as setas** ou **WASD** para navegar entre regiões
5. **Clique no minimapa** para pular para regiões específicas
6. **Chat** com outros usuários na mesma região
7. **Zoom** com a roda do mouse ou botões de controle

## 🗺️ Navegação

- **Setas direcionais** ou **WASD** - mover entre regiões
- **H** ou **Home** - voltar ao centro (8,8)
- **Clique e arraste** - pan da câmera
- **Roda do mouse** - zoom in/out
- **Minimapa** - clique para navegação rápida

## 🏗️ Arquitetura

- **FastAPI** - API backend e WebSocket server
- **Regiões 16x16** - canvas dividido em 256 regiões de 128x128 pixels
- **Carregamento automático** - regiões são carregadas conforme a navegação
- **Chat regional** - mensagens são isoladas por região
- **Rate limiting** - 5 segundos entre pixels por usuário

## 📊 Endpoints da API

- `GET /` - Interface principal
- `WebSocket /ws/{user_id}` - Comunicação em tempo real
- `GET /api/canvas/{region_x}/{region_y}` - Dados de região específica
- `GET /api/stats` - Estatísticas do canvas
- `GET /health` - Status do servidor

## 🎯 Futuras melhorias

- [ ] Persistência em banco de dados
- [ ] Sistema de autenticação
- [ ] Salas/canais temáticos
- [ ] Ferramentas de desenho avançadas
- [ ] Histórico de mudanças
- [ ] Sistema de moderação
