# RestOS Desktop

Electron desktop приложение для ресторанов. Работает оффлайн с PGlite.

## Структура

```
restos-desktop/
  main.js           — Electron главный процесс (окно + трей)
  preload.js         — Безопасный мост для рендерера
  api-server.js      — Express API + PGlite (для кассира и официантов)
  db.js              — PGlite PostgreSQL схема
  sync.js            — Синхронизация с Supabase
  frontend/          — Vite SPA билд (из restos/dist)
  assets/            — Иконки
```

## Разработка

```bash
npm install
npm run build-frontend   # Собрать фронтенд из ../restos
npm start                # Запустить Electron
```

## Сборка .exe

```bash
npm run dist:win
```

Создаст установщик в `release/`.

## Как работает

- Кассир: нативное окно Electron (полноэкранное)
- Официанты: браузер телефона → http://IP:3001 (тот же сервер)
- База данных: PGlite (встроенный PostgreSQL)
- Синхронизация: Supabase (когда интернет есть)
- Обновления: electron-updater (автоматически)
- Принтеры: через API сервер (TCP/USB)
