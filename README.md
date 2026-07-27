# 🤖 Website RAG Chatbot

> An AI-powered Retrieval-Augmented Generation (RAG) chatbot that scrapes website content, generates semantic embeddings locally using Ollama, performs vector similarity search, and answers user questions using relevant context.

---

## 📌 Project Overview

This project is being developed as part of my **AI/ML Internship at SolaceBit**.

The objective is to build a complete **Retrieval-Augmented Generation (RAG)** pipeline capable of answering questions about any website by first retrieving relevant information instead of relying solely on the Large Language Model's internal knowledge.

Unlike a traditional chatbot, this system grounds its responses using scraped website content, resulting in more accurate, reliable, and context-aware answers.

---

# 🚀 Features

### ✅ Phase 1 – Website Scraping
- Scrape any publicly accessible webpage
- Download raw HTML
- Parse HTML using Cheerio
- Extract:
  - Page Title
  - Headings
  - Paragraphs

### 🚧 Phase 2 – Text Processing
- Clean extracted content
- Remove duplicate text
- Remove navigation/footer noise
- Normalize whitespace
- Split content into overlapping chunks

### 🚧 Phase 3 – Embeddings
- Generate embeddings locally using Ollama
- Use `nomic-embed-text`
- Convert text chunks into vector representations

### 🚧 Phase 4 – Vector Search
- Store embeddings
- Compute cosine similarity
- Retrieve the most relevant chunks

### 🚧 Phase 5 – RAG Pipeline
- Retrieve relevant chunks
- Build contextual prompts
- Send prompts to Llama 3
- Generate grounded responses

### 🚧 Phase 6 – Chat Interface
- Express backend
- REST API
- Interactive chatbot interface

---

# 🏗️ System Architecture

```text
Website URL
      │
      ▼
 Website Scraper
      │
      ▼
 Text Cleaner
      │
      ▼
 Text Chunker
      │
      ▼
 Embedding Generator
 (nomic-embed-text)
      │
      ▼
 Vector Store
      │
      ▼
 Similarity Search
      │
      ▼
 Relevant Context
      │
      ▼
     Llama 3
      │
      ▼
 Final Answer
```

---

# 🛠️ Tech Stack

## Backend

- Node.js
- Express.js

## Web Scraping

- Axios
- Cheerio

## AI / Machine Learning

- Ollama
- Llama 3
- nomic-embed-text

## Version Control

- Git
- GitHub

---

# 📂 Project Structure

```text
website-rag-chatbot/
│
├── src/
│   ├── scraper/
│   │     └── scraper.js
│   │
│   └── test.js
│
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

---

# ⚙️ Installation

Clone the repository

```bash
git clone https://github.com/Ali-Akbar-Zaidi/SolaceBit-Internship.git
```

Navigate into the project

```bash
cd website-rag-chatbot
```

Install dependencies

```bash
npm install
```

---

# 🤖 Install Ollama

Download Ollama from:

https://ollama.com

Pull the required models

```bash
ollama pull llama3
```

```bash
ollama pull nomic-embed-text
```

Verify installation

```bash
ollama list
```

---

# ▶️ Run the Scraper

```bash
node src/test.js
```

---

# 📈 Development Roadmap

- [x] Project setup
- [x] Git repository
- [x] GitHub integration
- [x] Website scraper
- [x] HTML parsing
- [x] Title extraction
- [x] Heading extraction
- [x] Paragraph extraction

- [ ] Text cleaning
- [ ] Text chunking
- [ ] Embedding generation
- [ ] Vector database
- [ ] Similarity search
- [ ] Prompt engineering
- [ ] RAG pipeline
- [ ] Express API
- [ ] Chat interface

---

# 📚 Concepts Covered

This project demonstrates practical implementation of:

- Retrieval-Augmented Generation (RAG)
- Semantic Search
- Embeddings
- Vector Similarity Search
- Cosine Similarity
- Local LLM Inference
- Prompt Engineering
- HTML Parsing
- Web Scraping
- REST APIs
- JavaScript Async Programming

---

# 🎯 Learning Objectives

- Understand how modern RAG systems work
- Build an end-to-end AI application
- Work with local LLMs using Ollama
- Generate semantic embeddings
- Implement retrieval-based question answering
- Gain practical AI engineering experience

---

# 👨‍💻 Author

**Ali Akbar Zaidi**

AI/ML Intern — SolaceBit

GitHub: https://github.com/Ali-Akbar-Zaidi

---

# 📄 License

This project is developed for educational and internship purposes.