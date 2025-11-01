# Калькулятор гидравлики котельной

Статический веб‑калькулятор для учебной визуализации гидравлики: настенный котёл с встроенным насосом, радиаторный контур и тёплый пол через смеситель (без гидроразделителя).

## Запуск локально
Откройте файл `index.html` в браузере.

## Публикация на GitHub Pages
В репозитории настроен workflow `.github/workflows/deploy.yml`. После пуша в ветку `main` сайт автоматически публикуется в GitHub Pages.

Требуется один раз включить Pages:
- Settings → Pages → Build and deployment → Source: GitHub Actions.

После деплоя страница будет доступна по адресу из лога Actions (вида `https://<user>.github.io/gidrkotel/`).

## Структура
- `index.html`, `styles.css`, `script.js` — приложение
- `.github/workflows/deploy.yml` — деплой на Pages
- `.nojekyll` — отключение Jekyll

## Лицензия
MIT

