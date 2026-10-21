# Manual (español)

English version: [manual.md](manual.md). Las dos versiones describen los mismos pasos y comandos; un
cambio en una se hace también en la otra, en el mismo pull request.

Cómo usar esta plantilla, desde una máquina vacía hasta un proyecto en producción, con todos los
comandos que trae. Cada paso dice qué ejecutar, qué hace y qué deberías ver. Las demás páginas de
`docs/` (en inglés) contienen los motivos y el detalle; esta es el recorrido por ellas.

Convenciones:

- Los comandos se ejecutan desde la raíz del repositorio salvo que un paso diga otra cosa. En
  Windows usa **Git Bash** (se instala con Git for Windows): todos los comandos están escritos para
  él.
- Lo que va entre `<ángulos>` es un valor que sustituyes. `OWNER/REPO` es tu repositorio de GitHub.
- **REQUIERE CONFIGURACIÓN** marca un paso que solo tu proyecto puede completar (un proveedor, una
  cuenta, una decisión); la plantilla lo deja preparado pero no puede hacerlo por ti.
- `pnpm <script>` ejecuta un script de la raíz; `pnpm --filter api <script>` y
  `pnpm --filter web <script>` ejecutan un script de una sola app.
- Los mensajes que imprimen las herramientas se citan tal cual, en inglés: así los encuentras al
  buscarlos.

## Contenido

1. [Antes de empezar](#1-antes-de-empezar)
2. [Crea un proyecto desde la plantilla](#2-crea-un-proyecto-desde-la-plantilla)
3. [Desarrollo diario](#3-desarrollo-diario)
4. [Tests](#4-tests)
5. [Commits, pushes y pull requests](#5-commits-pushes-y-pull-requests)
6. [Configuración](#6-configuración)
7. [Referencia de comandos](#7-referencia-de-comandos)
8. [CI/CD](#8-cicd)
9. [Releases](#9-releases)
10. [Desplegar y hacer rollback](#10-desplegar-y-hacer-rollback)
11. [Infraestructura opcional](#11-infraestructura-opcional)
12. [Operar en producción](#12-operar-en-producción)
13. [Calendario de mantenimiento](#13-calendario-de-mantenimiento)
14. [Cuando algo falla](#14-cuando-algo-falla)
15. [Apéndice: puertos, cuentas y ficheros](#15-apéndice-puertos-cuentas-y-ficheros)

## 1. Antes de empezar

### 1.1 Instala las herramientas

| Herramienta           | Versión                                     | Comprobar                | Notas                                                                                                                                    |
| --------------------- | ------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js               | 24.15 o posterior, o 26+ (`.nvmrc`: 24)     | `node --version`         | nvm (`nvm install 24 && nvm use`), fnm (`fnm use`), Volta o el instalador oficial. Las versiones anteriores se rechazan.                 |
| pnpm                  | 12.5.1 (`packageManager` en `package.json`) | `pnpm --version`         | `corepack enable` una vez, y Corepack (incluido en Node) aporta la versión exacta. Sin Corepack: `npm install -g pnpm@12.5.1`.           |
| Docker con Compose v2 | cualquier versión actual                    | `docker compose version` | Docker Desktop (Windows, macOS) o Docker Engine (Linux). Hace falta para la base de datos, las imágenes y las herramientas de seguridad. |
| Git                   | cualquier versión actual                    | `git --version`          | Windows: Git for Windows, que trae Git Bash y `openssl`.                                                                                 |
| openssl               | cualquiera                                  | `openssl version`        | Genera secretos. Sin él: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.                                |
| GitHub CLI (opcional) | cualquier versión actual                    | `gh --version`           | Solo para los ajustes del repositorio de [2.9](#29-configura-github); todo se puede hacer también en la web.                             |

Disco: la imagen de la base de datos de desarrollo es pequeña; las imágenes de producción ocupan
alrededor de 1 GB cada una, el backend local de observabilidad (opcional) unos 3.7 GB y el escáner
DAST otros 3.7 GB.

### 1.2 Notas para Windows

- Si `pnpm db:up` falla con "port is already allocated" o "bind failed", Windows suele reservar el
  puerto de la base de datos (5442): usa otro ([2.4](#24-crea-los-ficheros-de-entorno)).
- Git Bash reescribe las rutas que empiezan por `/` cuando se las pasa a `docker`. Antepón
  `MSYS_NO_PATHCONV=1` a esos comandos (se indica donde hace falta).
- Docker Desktop tiene que estar arrancado antes de cualquier comando que use Docker.

## 2. Crea un proyecto desde la plantilla

Una vez por proyecto nuevo, en este orden.

### 2.1 Obtén el código

Marca el repositorio de la plantilla como plantilla en GitHub (Settings → **Template repository**) y
crea el repositorio nuevo con **Use this template**, y después clónalo; o cópialo sin su historial:

```
git clone --depth 1 <URL del repositorio de la plantilla> mi-proyecto
cd mi-proyecto
rm -rf .git
git init -b main
```

### 2.2 Renómbralo (REQUIERE CONFIGURACIÓN)

| Dónde                             | Qué cambiar                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` (raíz)             | `name`, `description`                                                                                                             |
| `README.md`                       | el título y el primer párrafo                                                                                                     |
| `apps/web/index.html`             | `<title>`, la meta description, `lang`                                                                                            |
| `apps/api/src/openapi/openapi.ts` | `.setTitle('API')`, y después ejecuta `pnpm contract`                                                                             |
| `apps/landing/src/lib/site.ts`    | `SITE_NAME`, el nombre en el sitio público; sus textos están en `apps/landing/src/i18n/` ([how-to](how-to.md#change-the-landing)) |
| `apps/landing/public/`            | `favicon.svg`, el icono, y `og.png`, la imagen que muestra un enlace compartido, con el nombre dibujado (1200 × 630)              |
| `SECURITY.md`                     | el contacto privado para reportar vulnerabilidades                                                                                |
| `.github/CODEOWNERS`              | usuarios o equipos reales en lugar de los marcadores, sin comentar                                                                |
| `LICENSE` (no viene ninguno)      | la licencia que necesite el producto, si se distribuye                                                                            |

Los paquetes del workspace se llaman `api`, `web` y `landing` a propósito: son privados y no hace
falta renombrarlos.

### 2.3 Instala

```
corepack enable        # una vez por máquina (Node.js 25+: antes npm install -g corepack)
pnpm install
```

Instala todas las apps, genera el cliente de Prisma (`prisma generate`) e instala los hooks de Git
(Husky configura `core.hooksPath`). Rechaza versiones de Node.js fuera de `engines`, paquetes
publicados hace menos de siete días y scripts de instalación nuevos que nadie ha revisado
([14](#14-cuando-algo-falla) lista los mensajes).

### 2.4 Crea los ficheros de entorno

```
cp apps/api/.env.example apps/api/.env
openssl rand -hex 32
```

Pega el valor impreso como `JWT_ACCESS_SECRET=` en `apps/api/.env`. Es el único valor que la API
necesita para arrancar en local; el fichero documenta todas las demás variables. Ya apunta el correo
al Mailpit local ([11.5](#115-correo)); borra `MAIL_SMTP_URL` y `SIGN_UP_ENABLED` (el registro
necesita correo) para trabajar sin él. También apunta la API al Redis local ([11.1](#111-redis));
borra `REDIS_URL`, `RATE_LIMIT_STORE`, `CACHE_STORE` y `REDIS_REQUIRED` para trabajar sin él.

Docker Compose lee el `.env` de la raíz. Créalo cuando necesites alguno de sus ajustes:

```
cp .env.example .env
```

- **Puerto 5442 ocupado:** la base de datos usa el 5442 y no el 5432 de PostgreSQL, para no chocar
  con un PostgreSQL instalado en la máquina. Si el 5442 también está ocupado: `DB_PORT=5443` en el
  `.env` de la raíz, y el mismo puerto en `DATABASE_URL` de `apps/api/.env`
  (`postgresql://app:app@localhost:5443/app`).
- **El stack tipo producción** ([2.7](#27-comprueba-que-pasan-todos-los-gates)): `JWT_ACCESS_SECRET`
  también en el `.env` de la raíz (otro `openssl rand -hex 32`).
- **Puertos 1035 u 8035 ocupados** (el SMTP y la web de Mailpit; no sus habituales 1025 y 8025,
  que puede tener el Mailpit de otro proyecto): `MAILPIT_SMTP_PORT` y `MAILPIT_UI_PORT` en el `.env`
  de la raíz, y el puerto SMTP en `MAIL_SMTP_URL` de `apps/api/.env`.
- **Puerto 6389 ocupado, u otra contraseña de Redis** ([11.1](#111-redis)): Redis usa el 6389 y no
  el 6379 de Redis, con la contraseña `app`: `REDIS_PORT` y `REDIS_PASSWORD` en el `.env` de la
  raíz, y lo mismo en `REDIS_URL` de `apps/api/.env`.

`apps/web/.env.example` y `apps/landing/.env.example` listan los ajustes opcionales de la web y de
la landing; ninguno es necesario.

Nunca hagas commit de un fichero `.env`: `.gitignore`, el hook de pre-commit y los escaneos de
secretos los rechazan.

### 2.5 Crea la base de datos

```
pnpm db:up        # PostgreSQL 18 en Docker, solo en 127.0.0.1, datos en el volumen db_data
pnpm db:migrate   # aplica todas las migraciones y regenera el cliente de Prisma
pnpm db:seed      # cuentas de desarrollo (contraseñas públicas; rechaza bases de datos no locales)
```

El seed imprime las cuentas: `admin@example.com` / `admin-password` y `member@example.com` /
`member-password`. Es idempotente: vuelve a ejecutarlo cuando quieras recuperarlas.

### 2.6 Arráncalo

```
pnpm dev
```

Arranca la base de datos, Redis y Mailpit (`pnpm services:up`, si estaban parados) y después la API,
la web y la landing (el sitio público) con recarga en caliente, e imprime estas direcciones en un
recuadro bajo sus logs, también tras cada reinicio:

| Qué                                        | URL                                             |
| ------------------------------------------ | ----------------------------------------------- |
| El sitio: la landing, en español en `/es/` | http://localhost:4321                           |
| La web, a través del sitio                 | http://localhost:4321/app/                      |
| API                                        | http://127.0.0.1:3000/api                       |
| Documentación de la API (Swagger)          | http://localhost:3000/api/docs                  |
| Liveness / readiness de la API             | http://127.0.0.1:3000/api/health/live, `/ready` |
| Correos que envió la API                   | http://localhost:8035 (Mailpit)                 |

El servidor de la landing es la entrada única del sitio, como la imagen web en producción: reenvía
`/app` al servidor de desarrollo de la web (que también responde por sí solo en
http://localhost:5173/app/) y `/api` a la API. Abre http://localhost:4321, sigue **Iniciar sesión**
e inicia sesión con una cuenta del seed. La primera línea de log de la API dice qué está activo:
`Starting release unversioned in development: tracing and metrics off, error tracking off, Redis on, email on`.

Para con `Ctrl+C`. `pnpm db:down` retira los contenedores de la base de datos, de Redis y de
Mailpit; los datos de la base de datos y de Redis se quedan en sus volúmenes de Docker (los mensajes
de Mailpit no), y los servicios opcionales siguen funcionando hasta
`docker compose --profile <perfil> down`.

### 2.7 Comprueba que pasan todos los gates

Ejecútalo una vez ahora, para saber que la máquina está preparada como CI:

```
pnpm verify                              # formato, lint, tipos, tests unitarios + cobertura, seguridad, build, presupuesto
pnpm test:integration                    # API contra PostgreSQL (y Redis, si está configurado)
pnpm exec playwright install chromium    # una vez por máquina
pnpm test:e2e                            # tests de navegador sobre el build (necesita pnpm build, que ya hace verify)
pnpm test:scripts                        # tests de los scripts del repositorio (selección de Semgrep, Doberman)
pnpm sast                                # Semgrep (Docker; unos minutos, ver 14)
pnpm lint:workflows                      # actionlint + zizmor + shellcheck (Docker)
pnpm observability:check                 # dashboards y reglas de alerta, promtool (Docker)
pnpm iac:check                           # Terraform, TFLint, Trivy, cloud-init, los dos scripts de roles (Docker)
docker compose --profile stack up --build   # imágenes de producción: el sitio en http://localhost:8080, la app en /app/
```

Para el último, el `.env` de la raíz necesita `JWT_ACCESS_SECRET`. En otra terminal,
`pnpm smoke --url http://localhost:8080` debe terminar con
`Smoke test passed (public URL only).` Páralo con `Ctrl+C` y después
`docker compose --profile stack down`.

### 2.8 Hazlo tuyo (REQUIERE CONFIGURACIÓN)

- El idioma de la interfaz, el sistema de diseño (`apps/web/src/index.css` es provisional), el
  nombre del producto.
- Roles: [how-to.md](how-to.md#add-a-role).
- El ciclo de vida de cuentas que necesite el producto además de recuperar y cambiar la
  contraseña y del registro público opcional (`SIGN_UP_ENABLED`): MFA o SSO
  (docs/security.md#authentication-and-tokens).
- Sustituye o amplía el módulo de ejemplo `users` con tu dominio; conserva `auth`, `health`,
  `common`, `observability`, `infrastructure` y `lifecycle`.
- Los umbrales de cobertura y el presupuesto de rendimiento son mínimos; ajústalos de forma
  deliberada ([testing.md](testing.md#coverage)).
- La política de licencias de las dependencias (`scripts/dependency-policy.json`), si la forma de
  distribuir el producto exige una más estricta o más laxa.
- Qué integraciones opcionales usará el proyecto ([11](#11-infraestructura-opcional)).
- `docs/template/` se puede borrar cuando el proyecto ya no necesite su historia.

### 2.9 Configura GitHub

El primer commit y el único push directo a `main` que hará el proyecto (el hook de pre-push
rechaza cualquier otro):

```
git add -A
git commit -m "chore: start from the project template"
git remote add origin <URL del repositorio>
git push --no-verify -u origin main
```

El primer commit pasa el hook de pre-commit por todos los ficheros (unos 40 segundos). Los mensajes
de commit van en inglés, como el resto del repositorio ([commits.md](commits.md)).

Después, los ajustes del repositorio (REQUIERE CONFIGURACIÓN), en la web o con `gh`:

| Ajuste                                                                                                      | Dónde / comando                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Solo squash merge, mensaje por defecto = título del pull request, borrar ramas tras el merge                | Settings → General → Pull Requests                                                                                                                                            |
| Ruleset de `main`: pull requests, **CI passed** y **Conventions**, code owners, sin force push              | `gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/main.json` (repositorio público o plan de pago)                                                      |
| Tags de release `v*` inmutables                                                                             | `gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/tags.json`                                                                                           |
| Token por defecto de solo lectura para los workflows                                                        | Settings → Actions → General → Workflow permissions → Read repository contents; marca "Allow GitHub Actions to create and approve pull requests" (el pull request de release) |
| Entornos `staging` y `production`, ramas de despliegue "solo `main`", revisores en producción               | Settings → Environments                                                                                                                                                       |
| Token opcional para los pull requests de release (todos los workflows de pull request se ejecutan en ellos) | `gh secret set RELEASE_PLEASE_TOKEN` (token de una GitHub App o fine-grained: contents, pull requests, issues)                                                                |
| Registro de las imágenes                                                                                    | `gh variable set IMAGE_PREFIX --body ghcr.io/OWNER/REPO`                                                                                                                      |
| DAST pasivo de staging, cuando exista                                                                       | `gh variable set DAST_STAGING_URL --body https://<host de staging>`                                                                                                           |
| CodeQL y dependency review (repositorio público o GitHub Advanced Security)                                 | `gh variable set ENABLE_CODEQL --body true`, `gh variable set ENABLE_DEPENDENCY_REVIEW --body true`                                                                           |
| Alertas y actualizaciones de seguridad de Dependabot, reporte privado de vulnerabilidades, push protection  | Settings → Code security                                                                                                                                                      |
| Secretos de despliegue de un entorno                                                                        | `gh secret set <NOMBRE> --env production` (o el gestor de secretos de la plataforma)                                                                                          |

Detalles y motivos: [ci-cd.md](ci-cd.md#repository-settings-requiere-configuración).

### 2.10 Antes de la primera release en producción

Recorre [production-readiness.md](production-readiness.md): backups y un simulacro de restore,
alertas y SLOs, el job de despliegue, los contactos de los runbooks de incidentes. Las secciones
[10](#10-desplegar-y-hacer-rollback) y [12](#12-operar-en-producción) de este manual los explican.

## 3. Desarrollo diario

### 3.1 Empieza el día

```
git switch main
git pull
pnpm install          # cuando cambió pnpm-lock.yaml
pnpm db:migrate       # cuando cambió apps/api/prisma/migrations/
pnpm dev
```

Si `apps/api/.env.example` tiene una variable nueva, cópiala a tu `apps/api/.env`. Si el editor
muestra tipos antiguos después de un pull, ejecuta "TypeScript: Restart TS Server" (VS Code).

### 3.2 Empieza un cambio

1. El issue cumple la [Definition of Ready](definition-of-ready.md) (la plantilla de feature pide
   cada punto).
2. Una rama desde `main` actualizado, con el nombre `<tipo>/<descripción>`:

   ```
   git switch -c feat/ABC-123-user-invitations
   ```

   Tipos: `feat`, `fix`, `hotfix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`,
   `release`. Comprueba un nombre con `node scripts/check-branch-name.mjs <nombre>`.

### 3.3 Haz el cambio

Recetas paso a paso, con código que pasa todos los gates, en [how-to.md](how-to.md):

| Cambio                                           | Receta                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Una tabla o una columna                          | [Add a table or a column](how-to.md#add-a-table-or-a-column)                               |
| Un recurso nuevo de la API                       | [Add an API module](how-to.md#add-an-api-module)                                           |
| Una ruta más                                     | [Add an endpoint](how-to.md#add-an-endpoint-to-an-existing-module)                         |
| Un cambio de contrato                            | [Change the API contract](how-to.md#change-the-api-contract)                               |
| Una pantalla                                     | [Add a screen](how-to.md#add-a-screen-to-the-web-app)                                      |
| Un test de navegador                             | [Add an end-to-end test](how-to.md#add-an-end-to-end-test)                                 |
| Un valor de configuración                        | [Add an environment variable](how-to.md#add-an-environment-variable)                       |
| Un rol                                           | [Add a role](how-to.md#add-a-role)                                                         |
| Una dependencia                                  | [Add a dependency](how-to.md#add-a-dependency)                                             |
| Una lectura cacheada                             | [Cache a read](how-to.md#cache-a-read)                                                     |
| Una llamada a una API de terceros                | [Call an external service](how-to.md#call-an-external-service)                             |
| Un job en una sola instancia, un mensaje una vez | [Run a job on one instance](how-to.md#run-a-job-on-one-instance-or-process-a-message-once) |
| Otra app o un worker                             | [Add another app](how-to.md#add-another-app-or-a-background-worker)                        |

Las reglas que sigue todo cambio: [ENGINEERING_STANDARDS.md](../ENGINEERING_STANDARDS.md).

### 3.4 Cambia el contrato de la API

Primero el contrato: escribe los esquemas Zod y las firmas del controlador, y después

```
pnpm contract
```

Exporta `openapi/openapi.json` desde el código y regenera `apps/web/src/api/schema.d.ts`. Revisa el
diff de `openapi.json`, haz commit de los dos ficheros y no los edites nunca a mano. Swagger UI
muestra el resultado en http://localhost:3000/api/docs mientras corre `pnpm dev`
([openapi/README.md](../openapi/README.md)).

### 3.5 Cambia la base de datos

1. Edita `apps/api/prisma/schema.prisma`.
2. Crea y aplica la migración, y regenera el cliente:

   ```
   pnpm db:migrate --name add_invitations
   ```

3. Lee el SQL generado en `apps/api/prisma/migrations/<timestamp>_add_invitations/migration.sql`:
   bloqueos en tablas grandes, valores por defecto, avisos de pérdida de datos.
4. Mantenla compatible con la versión que corre ahora (expand and contract) y sigue las reglas de
   migraciones seguras: [database.md](database.md#safe-migrations).

Otros comandos de base de datos:

| Comando                                        | Qué hace                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm --filter api exec prisma migrate status` | qué migraciones tiene aplicadas la base de datos de `DATABASE_URL`                   |
| `pnpm --filter api db:deploy`                  | `prisma migrate deploy`: aplica las migraciones pendientes, nunca crea una           |
| `pnpm --filter api exec prisma migrate reset`  | **solo desarrollo**: borra la base de datos y vuelve a aplicar todas las migraciones |
| `pnpm --filter api exec prisma generate`       | regenera el cliente (los comandos dev, lint, typecheck y test ya lo hacen)           |
| `pnpm --filter api exec prisma studio`         | una interfaz web sobre la base de datos de desarrollo                                |
| `docker compose exec db psql -U app -d app`    | una consola SQL en la base de datos de desarrollo                                    |

Nunca edites una migración que ya llegó a `main`; corrige hacia delante con una nueva.

### 3.6 Antes de hacer push

```
pnpm verify
```

Ejecuta, en orden y parando en el primer fallo: comprobación de formato, lint, typecheck, tests
unitarios y de componentes con cobertura, `pnpm security` (auditoría de dependencias, política de
dependencias, escaneo de secretos), build y presupuesto de rendimiento. Ejecuta también
`pnpm test:integration` si cambió la API y `pnpm test:e2e` si cambió un flujo de usuario.
Arreglos rápidos:

```
pnpm format        # reescribe los ficheros al estilo de Prettier
pnpm lint:fix      # aplica los arreglos automáticos de ESLint
```

## 4. Tests

| Tipo                       | Comando                                                                                            | Necesita                                             | Ficheros                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| Unitarios y de componentes | `pnpm test`                                                                                        | nada                                                 | `*.spec.ts`, `*.spec.tsx`                |
| Con cobertura              | `pnpm test:coverage`                                                                               | nada                                                 | informes en `apps/*/coverage/index.html` |
| Modo watch                 | `pnpm --filter api test:watch`, `pnpm --filter web test:watch`, `pnpm --filter landing test:watch` | nada                                                 |                                          |
| Un fichero                 | `pnpm --filter api exec vitest run src/users/users.service.spec.ts`                                | nada                                                 |                                          |
| Integración                | `pnpm test:integration`                                                                            | `pnpm services:up` (PostgreSQL, Redis, Mailpit)      | `apps/api/src/**/*.int.spec.ts`          |
| End-to-end                 | `pnpm test:e2e`                                                                                    | `pnpm services:up`, `pnpm build`, Chromium instalado | `e2e/*.e2e.ts`                           |
| End-to-end, interactivo    | `pnpm exec playwright test --ui`                                                                   | lo mismo                                             |                                          |
| Un solo test end-to-end    | `pnpm exec playwright test --grep "keeps members out"`                                             | lo mismo                                             |                                          |
| Último informe end-to-end  | `pnpm exec playwright show-report`                                                                 | una ejecución anterior                               | `playwright-report/`                     |

- **Los tests de integración** crean y migran `<db>_test` en el servidor de `DATABASE_URL`, nunca
  tocan la base de datos de desarrollo y se ejecutan de fichero en fichero.
- **Los specs de Redis** se ejecutan contra el Redis de desarrollo (`REDIS_URL` de `apps/api/.env`,
  como lo deja `.env.example`), cada ejecución bajo su propio prefijo de claves, o contra otro para
  una ejecución: `REDIS_TEST_URL=redis://:<contraseña>@127.0.0.1:<puerto> pnpm test:integration`.
  Sin URL de Redis se saltan en local; `CI=true` los hace obligatorios, como en CI.
- **Los tests end-to-end** usan `<db>_e2e` (se vuelve a sembrar en cada ejecución), la API compilada
  en el puerto 3100, la web compilada en el 4173 y la landing compilada en el 4321: para cualquier
  otra cosa que use esos puertos (un `pnpm dev` en marcha ocupa el 4321).
- **Los tests de la landing** renderizan sus páginas como lo hace el build (la API de contenedor de
  Astro) y comprueban los dos idiomas, los enlaces que leen los buscadores y la entrada a la
  aplicación; su suelo de cobertura es del 100 %.

Cómo escribir tests, mocks, fixtures y el trinquete de cobertura: [testing.md](testing.md).

## 5. Commits, pushes y pull requests

### 5.1 Commit

```
git add <ficheros>
git commit -m "feat(api): paginate the user list"
```

El mensaje es un Conventional Commit, en inglés: `<type>(<scope opcional>): <resumen>`, con los
tipos `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`,
`revert`; `!` y un pie `BREAKING CHANGE:` para los cambios incompatibles ([commits.md](commits.md)).
Para comprobar un mensaje sin hacer commit:
`printf 'feat(api): paginate the user list\n' | pnpm exec commitlint`.

Los hooks se ejecutan solos:

| Hook         | Ejecuta                                                                                                                                                          | Tarda        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `pre-commit` | sobre los ficheros en stage: rechaza ficheros `.env`, secretlint, `eslint --fix`, `prettier --write`, la comprobación de pasos de contracción de las migraciones | segundos     |
| `commit-msg` | commitlint                                                                                                                                                       | menos de 1 s |
| `pre-push`   | rechaza pushes a `main`/`master` y ramas mal nombradas, después `pnpm typecheck` y `pnpm test`                                                                   | unos 30 s    |

`--no-verify` se los salta: solo para el primer push de un repositorio nuevo o una emergencia real,
y diciéndolo en el pull request ([git-hooks.md](git-hooks.md)). CI ejecuta las mismas
comprobaciones igualmente.

### 5.2 Push y pull request

```
git push -u origin HEAD
gh pr create --fill        # o ábrelo en GitHub
```

- Rellena la plantilla del pull request; su título es un Conventional Commit (se convierte en el
  commit de `main` y en la línea del changelog).
- Espera a **CI passed** y **Conventions** ([8](#8-cicd)); si falla, lee el log del job y arréglalo
  en la rama.
- Consigue una revisión ([code-review.md](code-review.md)) y responde a cada comentario.
- Squash merge y borra la rama. El cambio está terminado cuando se cumple la
  [Definition of Done](../DEFINITION_OF_DONE.md).

## 6. Configuración

### 6.1 Dónde vive la configuración

| Fichero                     | Lo lee                                                                | En git |
| --------------------------- | --------------------------------------------------------------------- | ------ |
| `apps/api/.env`             | la API y el CLI de Prisma, en desarrollo                              | nunca  |
| `apps/api/.env.example`     | documentación de todas las variables de la API                        | sí     |
| `.env` (raíz)               | Docker Compose: puertos, el secreto del stack, la contraseña de Redis | nunca  |
| `.env.example` (raíz)       | documentación de las variables de Compose                             | sí     |
| `apps/web/.env.example`     | los ajustes opcionales de la web                                      | sí     |
| `apps/landing/.env.example` | el ajuste opcional del build de la landing                            | sí     |

Las variables definidas en el entorno ganan a los ficheros `.env`; los despliegues las toman del
gestor de secretos de la plataforma. La API valida todo al arrancar y se detiene nombrando la
variable si un valor es incorrecto: `Environment variable JWT_ACCESS_SECRET is invalid: ...`.

### 6.2 Variables de la API

Obligatorias: `NODE_ENV`, `DATABASE_URL`, `JWT_ACCESS_SECRET`; en producción también `TRUST_PROXY`.
Todo lo demás tiene un valor por defecto seguro. La tabla completa con cada regla:
[environment.md](environment.md).

| Grupo             | Variables (valor por defecto)                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ejecución         | `NODE_ENV` (ninguno), `HOST` (127.0.0.1; todas las interfaces en producción), `PORT` (3000)                                                                                                                                                                                  |
| Base de datos     | `DATABASE_URL` (ninguno), `DB_SLOW_QUERY_MS` (500), `DB_POOL_MAX` (10), `DB_STATEMENT_TIMEOUT_MS` (30000)                                                                                                                                                                    |
| Autenticación     | `JWT_ACCESS_SECRET` (ninguno), `JWT_ACCESS_SECRET_PREVIOUS` (sin definir), `AUTH_COOKIE_SAMESITE` (strict)                                                                                                                                                                   |
| HTTP              | `CORS_ORIGINS` (vacío), `APP_ORIGIN` (sin definir; defínela en producción; obligatoria con correo), `APP_BASE_PATH` (/app: dónde se sirve la web bajo ese origen), `TRUST_PROXY` (loopback; obligatoria en producción), `RATE_LIMIT_MAX` (100), `RATE_LIMIT_WINDOW_SEC` (60) |
| Logs e identidad  | `LOG_LEVEL` (log), `LOG_FORMAT` (json en producción, si no text), `APP_ENVIRONMENT` (NODE_ENV), `APP_RELEASE` (de la imagen, si no unversioned)                                                                                                                              |
| Error tracking    | `SENTRY_DSN` (sin definir: apagado), `SENTRY_SAMPLE_RATE` (1)                                                                                                                                                                                                                |
| Trazas y métricas | `OTEL_EXPORTER_OTLP_ENDPOINT` (sin definir: apagado), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SDK_DISABLED` (false), `OTEL_SERVICE_NAME` (api), `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_METRIC_EXPORT_INTERVAL` (60000), `OTEL_RESOURCE_ATTRIBUTES`              |
| Redis             | `REDIS_URL` (sin definir: apagado), `REDIS_KEY_PREFIX` (app:), `REDIS_REQUIRED` (false), `REDIS_COMMAND_TIMEOUT_MS` (500), `RATE_LIMIT_STORE` (memory), `CACHE_STORE` (memory); `apps/api/.env.example` enciende Redis para desarrollo                                       |
| Correo            | `MAIL_SMTP_URL` (sin definir: apagado), `MAIL_FROM` (obligatoria con ella), `MAIL_MAX_ATTEMPTS` (8), `MAIL_DAILY_LIMIT_PER_ADDRESS` (10), `SIGN_UP_ENABLED` (false; requiere correo)                                                                                         |

### 6.3 Variables de la web

Se definen en el contenedor web (la imagen de producción) y la app las recibe en
`/app/app-config.json`; los servidores de desarrollo y preview de Vite leen los mismos nombres de
su entorno:

`APP_ORIGIN` (obligatoria, sin valor por defecto: el origen público del sitio, que nginx escribe en
los enlaces absolutos de la landing al servirla; el destino VPS la deriva de `APP_DOMAIN`),
`API_UPSTREAM` (http://api:3000, la API a la que el servidor web reenvía `/api`), `APP_ENVIRONMENT`
(production), `APP_RELEASE` (lo fija el build de la imagen), `WEB_SENTRY_DSN` (vacío: apagado),
`WEB_SENTRY_SAMPLE_RATE` (1), `WEB_VITALS_SAMPLE_RATE` (1, la proporción de cargas de página que
informan de sus Web Vitals; 0: apagado). Solo en desarrollo: `API_PROXY_TARGET`
(http://127.0.0.1:3000).
Todo lo que se llame `VITE_*` se compila en el bundle público: nunca un secreto.

La landing lee una variable, al compilarse: `PUBLIC_URL` (http://localhost:4321), el origen público
de sus enlaces canónicos y alternativos, su sitemap y su robots.txt (la imagen web la compila para
un marcador que `APP_ORIGIN` sustituye). Los reenvíos de su servidor de desarrollo se mueven con
`API_PROXY_TARGET` (http://127.0.0.1:3000) y `WEB_PROXY_TARGET` (http://localhost:5173)
([environment.md](environment.md#landing-variables)).

### 6.4 Variables de Compose (`.env` de la raíz)

`DB_PORT` (5442), `REDIS_PORT` (6389), `REDIS_PASSWORD` (app), `MAILPIT_SMTP_PORT` (1035),
`MAILPIT_UI_PORT` (8035), `JWT_ACCESS_SECRET` (la API del stack), `WEB_PORT` (8080),
`OTLP_HTTP_PORT` (4318), `GRAFANA_PORT` (3001), `PROMETHEUS_PORT` (9090), `APP_RELEASE` (la release
de las imágenes del stack, por defecto `local`); los ajustes de Redis del propio stack, que por
defecto usan el Redis de Compose: `STACK_REDIS_URL`, `STACK_RATE_LIMIT_STORE`, `STACK_CACHE_STORE`;
y sus integraciones opcionales: `STACK_OTEL_EXPORTER_OTLP_ENDPOINT`, `STACK_SENTRY_DSN`,
`STACK_WEB_SENTRY_DSN`.

### 6.5 Por entorno

| Ajuste                   | desarrollo                    | CI                               | staging                                                     | producción               |
| ------------------------ | ----------------------------- | -------------------------------- | ----------------------------------------------------------- | ------------------------ |
| `NODE_ENV`               | `development`                 | `test`                           | `production`                                                | `production`             |
| `APP_ENVIRONMENT`        | por defecto                   | por defecto                      | `staging`                                                   | `production`             |
| `TRUST_PROXY`            | por defecto                   | por defecto                      | el número real de saltos                                    | el número real de saltos |
| Secretos                 | `apps/api/.env`, `.env` raíz  | generados en cada ejecución      | gestor de secretos; el destino VPS: ficheros en el servidor | lo mismo                 |
| Redis                    | el Redis de Compose           | un servicio Redis para sus specs | el del propio servidor (destino VPS), o uno privado         | lo mismo                 |
| Integraciones opcionales | apagadas, o servicios locales | apagadas                         | según se decida                                             | según se decida          |

## 7. Referencia de comandos

Todos los comandos que trae la plantilla.

### 7.1 Scripts de la raíz (`pnpm <script>`)

| Comando                                                                  | Qué hace                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                                           | instala el workspace; ejecuta `prepare` (instala los hooks de Git) y el `postinstall` de la API (`prisma generate`)                                                                            |
| `pnpm dev`                                                               | `pnpm services:up`, y después la API (`nest start --watch`), la web (Vite) y la landing (Astro) en paralelo; sus URLs en un recuadro bajo los logs                                             |
| `pnpm build`                                                             | compila todas las apps (`apps/*/dist`)                                                                                                                                                         |
| `pnpm lint`                                                              | ESLint sobre todo el repositorio, sin warnings permitidos                                                                                                                                      |
| `pnpm lint:fix`                                                          | lo mismo, aplicando los arreglos automáticos                                                                                                                                                   |
| `pnpm format`                                                            | Prettier reescribe todos los ficheros                                                                                                                                                          |
| `pnpm format:check`                                                      | Prettier informa de los ficheros sin formatear                                                                                                                                                 |
| `pnpm typecheck`                                                         | TypeScript en todas las apps (`astro check` en la landing), la comprobación de los tipos del contrato y los scripts del repositorio                                                            |
| `pnpm test`                                                              | tests unitarios y de componentes de todas las apps                                                                                                                                             |
| `pnpm test:coverage`                                                     | lo mismo con los umbrales de cobertura                                                                                                                                                         |
| `pnpm test:integration`                                                  | la API contra PostgreSQL (y Redis y Mailpit si están configurados)                                                                                                                             |
| `pnpm test:e2e`                                                          | Playwright sobre la app y la landing compiladas                                                                                                                                                |
| `pnpm test:scripts`                                                      | los tests de los scripts del repositorio (`scripts/*.test.mjs`: selección de ficheros de Semgrep, motor de Doberman)                                                                           |
| `pnpm security`                                                          | `pnpm audit --audit-level=high`, después `pnpm deps:check`, después `pnpm secrets:scan`                                                                                                        |
| `pnpm deps:check`                                                        | política de dependencias: orígenes del registro con integridad, licencias y los ajustes de supply chain de `pnpm-workspace.yaml`                                                               |
| `pnpm secrets:scan`                                                      | secretlint sobre todos los ficheros que git sigue o añadiría                                                                                                                                   |
| `pnpm sast`                                                              | Semgrep con la imagen fijada (Docker)                                                                                                                                                          |
| `pnpm lint:workflows`                                                    | actionlint, zizmor y shellcheck con las imágenes fijadas (Docker)                                                                                                                              |
| `pnpm observability:check`                                               | los dashboards y las reglas de alerta de `observability/` (fuentes de datos, runbooks, nombres de métricas), después promtool y los tests unitarios de las reglas (Docker)                     |
| `pnpm iac:check`                                                         | las comprobaciones de `infra/terraform` (fmt, validate, tests, TFLint, Trivy, cloud-init, roles de la base de datos) y de `deploy/vps/db-init.sh` sobre PostgreSQL (Docker)                    |
| `pnpm iac:database`                                                      | los roles de la base de datos de un entorno de DigitalOcean hecho con Terraform (`deploy-vps.md`)                                                                                              |
| `pnpm sbom:generate`                                                     | SBOM CycloneDX de las dependencias de producción en `dist/sbom/sbom.cdx.json`                                                                                                                  |
| `pnpm perf:check`                                                        | tamaño gzip de los assets compilados de la web y de la landing frente al `performance-budget.json` de cada app (después de `pnpm build`)                                                       |
| `pnpm smoke --url <URL pública> --api <URL de la API> [--release <sha>]` | smoke test de solo lectura de un despliegue en marcha ([10.3](#103-smoke-test))                                                                                                                |
| `pnpm contract`                                                          | exporta `openapi/openapi.json` y regenera los tipos del cliente web                                                                                                                            |
| `pnpm services:up`                                                       | `docker compose up --detach --wait db redis mailpit`: la base de datos, Redis y el capturador de correo                                                                                        |
| `pnpm db:up`                                                             | `docker compose up --detach --wait db`                                                                                                                                                         |
| `pnpm db:down`                                                           | `docker compose down`: retira los contenedores de la base de datos, de Redis y de Mailpit y conserva los datos de la base de datos y de Redis; los servicios opcionales se paran con su perfil |
| `pnpm db:migrate [--name <nombre>]`                                      | crea una migración a partir de los cambios del esquema, aplica las pendientes y regenera el cliente (desarrollo)                                                                               |
| `pnpm db:seed`                                                           | cuentas de desarrollo (solo bases de datos locales; `--allow-remote-database` para una remota desechable)                                                                                      |
| `pnpm verify`                                                            | `format:check` → `lint` → `typecheck` → `test:coverage` → `security` → `build` → `perf:check`                                                                                                  |

### 7.2 Scripts de la API (`pnpm --filter api <script>`)

| Script             | Qué hace                                                                                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`              | `prisma generate`, después `nest start --watch`                                                                                                                                                                                                                                                                  |
| `build`            | `prisma generate`, después `nest build` en `apps/api/dist`                                                                                                                                                                                                                                                       |
| `start`            | `node dist/main.js` (después de `build`)                                                                                                                                                                                                                                                                         |
| `typecheck`        | `prisma generate`, después `tsc --noEmit`                                                                                                                                                                                                                                                                        |
| `test`             | tests unitarios con Vitest                                                                                                                                                                                                                                                                                       |
| `test:watch`       | Vitest en modo watch                                                                                                                                                                                                                                                                                             |
| `test:coverage`    | tests unitarios con los umbrales de cobertura de `vitest.config.ts`                                                                                                                                                                                                                                              |
| `test:integration` | la suite de integración (`vitest.config.int.ts`)                                                                                                                                                                                                                                                                 |
| `openapi:export`   | compila y escribe `openapi/openapi.json` (la mitad de `pnpm contract`)                                                                                                                                                                                                                                           |
| `db:migrate`       | `prisma migrate dev` + `prisma generate` (`scripts/migrate.mjs`)                                                                                                                                                                                                                                                 |
| `db:deploy`        | `prisma migrate deploy`                                                                                                                                                                                                                                                                                          |
| `db:seed`          | compila y ejecuta el seed                                                                                                                                                                                                                                                                                        |
| `user:create`      | crea una cuenta en la base de datos de `DATABASE_URL`, en cualquier entorno, con la contraseña por la entrada estándar: `printf '%s' "$PASSWORD" \| pnpm --filter api user:create --email <email> --name <nombre> --role admin` ([deploy-vps.md](deploy-vps.md#9-create-the-first-administrator) en un servidor) |
| `mail`             | los comandos de operación de la bandeja de salida del correo ([11.5](#115-correo)): `mail test --to <dirección>` (encola un mensaje de prueba y espera su entrega), `mail status [--to <dirección>]`, `mail retry --id <id> \| --failed [--kind <tipo>]`                                                         |
| `e2e:server`       | prepara `<db>_e2e` y arranca la API compilada para Playwright (lo lanza `pnpm test:e2e`)                                                                                                                                                                                                                         |

### 7.3 Scripts de la web (`pnpm --filter web <script>`)

| Script          | Qué hace                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dev`           | servidor de desarrollo de Vite en http://localhost:5173/app/ (la app se compila para `/app/`), con `/api` reenviado a la API |
| `build`         | `tsc -b`, después `vite build` en `apps/web/dist`                                                                            |
| `preview`       | sirve el build en http://localhost:4173/app/, con `/api` reenviado                                                           |
| `typecheck`     | comprueba `schema.d.ts` contra el contrato, después `tsc -b`                                                                 |
| `test`          | tests de componentes y unitarios con Vitest                                                                                  |
| `test:watch`    | modo watch                                                                                                                   |
| `test:coverage` | con los umbrales de cobertura de `vite.config.ts`                                                                            |
| `api:types`     | regenera `src/api/schema.d.ts` desde `openapi/openapi.json` (la mitad de `pnpm contract`)                                    |

### 7.4 Scripts de la landing (`pnpm --filter landing <script>`)

| Script          | Qué hace                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`           | servidor de desarrollo de Astro en http://localhost:4321, la entrada única del sitio: `/app` reenviado al servidor de desarrollo de la web, `/api` a la API |
| `build`         | `astro check`, después `astro build` en `apps/landing/dist`: las páginas, el sitemap y robots.txt                                                           |
| `preview`       | sirve el build en http://localhost:4321                                                                                                                     |
| `typecheck`     | `astro check`: los tipos de los ficheros `.astro` y `.ts`, que también falla con avisos                                                                     |
| `test`          | tests unitarios y de páginas con Vitest                                                                                                                     |
| `test:watch`    | modo watch                                                                                                                                                  |
| `test:coverage` | con los umbrales de cobertura de `vitest.config.ts`                                                                                                         |

Todos los scripts ejecutan el CLI de Astro a través de `apps/landing/scripts/astro.mjs`, que apaga
la telemetría de uso de Astro y mantiene sus servidores en primer plano, donde `pnpm dev` y
Playwright los paran.

### 7.5 Scripts del repositorio que se ejecutan directamente

| Comando                                                                                                         | Qué hace                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/check-branch-name.mjs [rama]`                                                                     | comprueba el nombre de una rama (por defecto, la actual)                                                                                                         |
| `node scripts/tool-image.mjs <nombre>`                                                                          | imprime la imagen fijada de una herramienta: `actionlint`, `zizmor`, `semgrep`, `gitleaks`, `trivy`, `terraform`, `tflint`, `ubuntu`, `postgres`, `redis`, `zap` |
| `node scripts/smoke-test.mjs ...`                                                                               | el smoke test (`pnpm smoke`)                                                                                                                                     |
| `node apps/web/scripts/api-types.mjs [--check]`                                                                 | regenera, o comprueba, los tipos del cliente web                                                                                                                 |
| `scripts/git/pre-push.mjs`, `scripts/forbid-env-files.mjs`                                                      | los usan los hooks de Git                                                                                                                                        |
| `node scripts/check-migrations.mjs [<migration.sql>...]`                                                        | pasos de contracción sin motivo en las migraciones ([database.md](database.md#expand-and-contract)); lo ejecutan `pnpm test:scripts` y el hook de pre-commit     |
| `scripts/check-dependencies.mjs`, `scan-secrets.mjs`, `sast.mjs`, `lint-workflows.mjs`, `check-bundle-size.mjs` | están detrás de los scripts de la raíz con el mismo propósito                                                                                                    |
| `scripts/check-iac.mjs`, `scripts/iac-database.mjs`                                                             | están detrás de `pnpm iac:check` y `pnpm iac:database`                                                                                                           |

### 7.6 Docker Compose

| Comando                                                                       | Qué arranca                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:up`                                                                  | `db`: PostgreSQL 18, `127.0.0.1:${DB_PORT:-5442}`                                                                                                                                                                                                                             |
| `pnpm services:up`                                                            | `db`; `redis`: Redis 8 con contraseña (`app`), `127.0.0.1:${REDIS_PORT:-6389}`, datos en el volumen `redis_data`; y `mailpit`: el capturador de correo, SMTP en `127.0.0.1:${MAILPIT_SMTP_PORT:-1035}`, web en http://localhost:8035 (`MAILPIT_UI_PORT`), mensajes en memoria |
| `docker compose --profile observability up -d`                                | `otel-lgtm`: collector, Prometheus, Tempo, Loki y Grafana con los dashboards y las reglas de `observability/`; OTLP en el 4318, Grafana en http://localhost:3001, Prometheus en el 9090                                                                                       |
| `docker compose --profile stack up --build`                                   | `migrate` (se ejecuta una vez), `api`, `web`: las imágenes de producción, sobre `db` y `redis`; el sitio en http://localhost:8080 y la app en `/app/`                                                                                                                         |
| `docker compose --profile stack --profile observability up --build`           | el stack con todos los servicios opcionales (define las variables `STACK_*`, [6.4](#64-variables-de-compose-env-de-la-raíz))                                                                                                                                                  |
| `docker compose ps`                                                           | qué está corriendo, con su estado de salud                                                                                                                                                                                                                                    |
| `docker compose logs -f <servicio>`                                           | sigue el log de un servicio (`api`, `web`, `db`, `mailpit`, `redis`, `migrate`)                                                                                                                                                                                               |
| `docker compose --profile <perfil> down`                                      | para y retira esos contenedores; los volúmenes se quedan                                                                                                                                                                                                                      |
| `docker compose down -v`                                                      | **borra también los volúmenes**: se pierden los datos de la base de datos de desarrollo y de Redis                                                                                                                                                                            |
| `docker compose exec db psql -U app -d app`                                   | consola SQL                                                                                                                                                                                                                                                                   |
| `docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli'` | consola de Redis (la contraseña no aparece en la línea de comandos)                                                                                                                                                                                                           |

### 7.7 Imágenes sin Compose

```
docker build -f apps/api/Dockerfile -t api --build-arg APP_RELEASE=$(git rev-parse HEAD) .
docker build -f apps/api/Dockerfile --target migrate -t api-migrate .
docker build -f apps/web/Dockerfile -t web --build-arg APP_RELEASE=$(git rev-parse HEAD) .
```

El contexto de build es la raíz del repositorio (una lista de permitidos en `.dockerignore`). La
imagen de migraciones ejecuta `prisma migrate deploy` por defecto, después de rechazar una base de
datos cuyas migraciones aplicadas se editaron después (`apps/api/scripts/migrate-deploy.mjs`); la
misma imagen responde a los demás comandos de migración ([7.8](#78-comandos-de-operación)).

### 7.8 Comandos de operación

| Comando                                                                                                                                                   | Uso                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl http://<api>:3000/api/health/ready`                                                                                                                 | readiness de una instancia, desde dentro de la plataforma                                                                                                                                    |
| `docker compose ... run --rm -T api node dist/infrastructure/mail/mail.cli.js status` (`test --to <dirección>`, `retry --failed`)                         | la bandeja de salida del correo: qué espera, qué falló y por qué; una prueba de entrega; reenviar los fallidos ([11.5](#115-correo))                                                         |
| `pnpm smoke --url <URL pública> --api <URL de la API> --release <sha>`                                                                                    | después de un despliegue, un restore o un incidente                                                                                                                                          |
| `docker run --rm -e DATABASE_URL=<url> <imagen api-migrate>`                                                                                              | rechaza una base de datos cuyas migraciones aplicadas se editaron y después aplica las pendientes                                                                                            |
| `docker run --rm -e DATABASE_URL=<url> <imagen api-migrate> node node_modules/prisma/build/index.js migrate status`                                       | qué migraciones tiene un entorno                                                                                                                                                             |
| `... migrate resolve --rolled-back <migración>` / `--applied <migración>`                                                                                 | registra el resultado de una migración fallida ([database.md](database.md#when-a-migration-fails))                                                                                           |
| `... migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`                                                                  | compara el esquema de un entorno con el de la imagen, después de un restore ([disaster-recovery.md](disaster-recovery.md#restore-procedure))                                                 |
| `pg_dump`, `pg_restore`, `createdb`                                                                                                                       | backups y restores ([disaster-recovery.md](disaster-recovery.md#rehearsal-on-a-development-machine))                                                                                         |
| `docker compose ... exec backup sh /usr/local/bin/backup.sh now`                                                                                          | un backup en el acto, en la base de datos propia del destino VPS ([deploy-vps.md](deploy-vps.md#backups)); su restore: [disaster-recovery.md](disaster-recovery.md#the-servers-own-database) |
| `BEGIN; SELECT id FROM users WHERE id = '<id>' FOR UPDATE; UPDATE sessions SET revoked_at = now() WHERE user_id = '<id>' AND revoked_at IS NULL; COMMIT;` | termina todas las sesiones de un usuario (incidente de seguridad); el bloqueo del usuario impide que un refresh en curso la sobreviva                                                        |

## 8. CI/CD

### 8.1 Workflows

| Workflow                    | Se ejecuta                                                   | Hace                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` (**CI**)           | en cada pull request, en cada push a `main`, a mano          | dependency review (opcional), todos los gates, las imágenes; un check: **CI passed**                                                     |
| `conventions.yml`           | en cada pull request, y otra vez al editar su título         | nombre de la rama y título (Conventional Commits); su check **Conventions** es obligatorio                                               |
| `quality-gates.yml`         | lo llaman CI y Deploy                                        | formato, lint, tipos, workflows, Semgrep, infraestructura como código, tests con cobertura, integración, seguridad, build, E2E, imágenes |
| `docker-images.yml`         | lo llaman los gates (build y escaneo) y un despliegue (push) | construye `api`, `api-migrate`, `web` y las escanea con Trivy; las publica con SBOM y provenance cuando se le pide                       |
| `codeql.yml`                | pull requests, `main`, semanal, si `ENABLE_CODEQL=true`      | análisis de seguridad entre ficheros (ADVISORY)                                                                                          |
| `dast.yml`                  | los lunes a las 04:41 UTC, a mano                            | imágenes de producción en el runner, smoke test, ZAP baseline y API scan; o el escaneo pasivo de staging (ADVISORY)                      |
| `release.yml`               | pushes a `main`                                              | el pull request de release y el CI en él; una vez mergeado, el tag, la GitHub release y el SBOM                                          |
| `main-guard.yml`            | en cada push a `main`                                        | comprueba que cada commit subido es un pull request mergeado; si no, falla y abre un issue                                               |
| `dependabot-auto-merge.yml` | al aprobar un pull request de Dependabot                     | mergea una actualización patch o minor cuando **CI passed** pasa (comprueba él mismo la aprobación y el CI)                              |
| `deploy.yml` (**Deploy**)   | a mano, desde `main`                                         | resuelve la ref a un commit de `main`, repite los gates y publica la release (el destino VPS, o un job propio)                           |

Dependabot abre cada semana pull requests de actualización agrupados (npm, GitHub Actions, imágenes
base, imágenes de herramientas, proveedores de Terraform), con el mismo retraso de siete días que la
política de instalación.
Tú apruebas cada uno; una actualización patch o minor se mergea sola cuando pasa el CI, y las
majors o las de workflows las mergeas a mano ([ci-cd.md](ci-cd.md#dependency-updates)).

### 8.2 Ejecutarlos y leerlos

```
gh run list                              # ejecuciones recientes
gh run watch                             # sigue la ejecución en curso
gh run view <id de la ejecución> --log-failed   # los logs de los pasos que fallaron
gh run rerun <id de la ejecución> --failed      # repite solo los jobs fallidos
gh workflow run ci.yml --ref <rama>      # CI a mano
gh workflow run dast.yml -f target=local-stack
gh workflow run dast.yml -f target=staging
```

Los informes quedan adjuntos a la ejecución como artefactos (cobertura, informe de Playwright,
informes de ZAP). Qué es BLOCKING y qué es ADVISORY, y por qué:
[ci-cd.md](ci-cd.md#quality-gates-blocking-and-advisory). Cada mensaje de fallo con su arreglo:
[troubleshooting.md](troubleshooting.md).

Las mismas comprobaciones en local: `pnpm verify`, `pnpm test:integration`, `pnpm test:e2e`,
`pnpm sast`, `pnpm lint:workflows`, `pnpm observability:check`, `pnpm iac:check`.

## 9. Releases

1. Mergea pull requests con títulos Conventional Commit. `fix:`/`perf:` generan un patch, `feat:` un
   minor, `!` o `BREAKING CHANGE:` un major (antes de 1.0.0: un minor).
2. **Release** mantiene abierto un pull request de release con la siguiente versión y la entrada de
   `CHANGELOG.md`. Revísalo como cualquier pull request.
3. Mergéalo: el workflow crea el tag `vX.Y.Z` (inmutable), publica la GitHub release con las notas y
   adjunta `sbom.cdx.json`.
4. Despliega el tag ([10](#10-desplegar-y-hacer-rollback)): publicar una release y desplegarla son
   pasos separados.

La versión continúa desde el `1.0.0` de la plantilla: el primer `fix` da 1.0.1, el primer `feat`
1.1.0; el pie `Release-As: <versión>` en un commit mergeado elige otra. El workflow de release lanza
él mismo el CI y **Conventions** en el pull request de release; con `RELEASE_PLEASE_TOKEN`
configurado, en cambio, se ejecutan en él todos los workflows de pull request
([ci-cd.md](ci-cd.md#release-pull-requests)).

## 10. Desplegar y hacer rollback

### 10.1 Implementa el job de release una vez (REQUIERE CONFIGURACIÓN)

**Destino listo para usar:** un servidor Linux por entorno con Docker, Redis y PostgreSQL en él
(backups nocturnos incluidos), o un PostgreSQL gestionado en su lugar. Define la variable del
repositorio `DEPLOY_TARGET=vps` y sigue [deploy-vps.md](deploy-vps.md) (paso a paso:
[step-by-step.es.md](step-by-step.es.md#fase-7-servidores-de-producción)); no hay que escribir nada
de lo que sigue. En DigitalOcean, Terraform (`infra/terraform/digitalocean`) puede crear los
servidores y las bases de datos gestionadas en lugar de los pasos manuales, con el mismo resultado
([deploy-vps.md](deploy-vps.md#provision-with-terraform-digitalocean)). Para cualquier otra
plataforma:

`.github/workflows/deploy.yml` repite todos los gates sobre el commit exacto y después pasa al
entorno protegido, donde el job de release falla a propósito hasta que se escribe para tu
plataforma. Impleméntalo en este orden (los comentarios del fichero lo repiten):

1. Publica las imágenes una vez por commit (`docker-images.yml` con `push: true`, después del paso de
   login al registro marcado en ese fichero), escanea los digests que informa la publicación y
   guárdalos; reutiliza los digests que guardó staging, para que producción ejecute lo que staging
   verificó, y vuelve a escanearlos antes de producción.
2. Despliega solo `<imagen>@<digest>`, con los digests del build o de ese registro: nunca los
   busques por el tag `<imagen>:<sha>`, que cualquier workflow con `packages: write` puede publicar.
3. Guarda los digests que estaban corriendo antes del cambio: son el destino del rollback.
4. Ejecuta la imagen `api-migrate` contra la base de datos del entorno; para si falla.
5. Despliega `api` y después `web`, esperando a que estén ready.
6. `node scripts/smoke-test.mjs --url <URL pública> --api <URL de la API> --release <sha>`.
7. Si algo falla, vuelve a desplegar los digests guardados.

La secuencia completa, las reglas de compatibilidad entre versiones y la tabla de rollback:
[ci-cd.md](ci-cd.md#deployment).

### 10.2 Despliega

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=v1.4.0
gh run watch
```

O en GitHub → Actions → **Deploy** → Run workflow (desde `main`), con el entorno y la ref (un tag
de release, una rama o un SHA de commit de `main`). Primero staging; verifica; después la misma ref
a `production` (el entorno pide la aprobación de sus revisores).

### 10.3 Smoke test

```
pnpm smoke --url https://<host público> --api http://<api dentro de la plataforma>:3000 --release <sha>
```

| Comprobación                    | Pasa cuando                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| web server health               | `/healthz` responde 200                                                                                                                                                        |
| landing                         | `/` es la landing, con sus enlaces y su imagen para compartir en el origen de este despliegue (`APP_ORIGIN`) y las cabeceras CSP y `X-Content-Type-Options`; `/es/` en español |
| share picture                   | `/og.png` responde 200 como PNG                                                                                                                                                |
| not-found page                  | una dirección desconocida responde 404 con la página de no encontrado                                                                                                          |
| app shell                       | `/app/` y un enlace profundo bajo ella son la app                                                                                                                              |
| emailed links of before `/app/` | `/reset-password` redirige a `/app/reset-password`                                                                                                                             |
| runtime configuration           | `/app/app-config.json` responde, con la release esperada si se pasa `--release`                                                                                                |
| API through the web server      | una ruta `/api/...` desconocida responde el 404 JSON de la API con un request id                                                                                               |
| probes not public               | `/api/health/ready` responde 404 por la URL pública                                                                                                                            |
| API liveness y readiness        | 200 en la propia API (`degraded` se informa, no es un fallo)                                                                                                                   |

No inicia sesión ni escribe nada; cualquier fallo sale con código 1. Se puede omitir cualquiera de
las dos URLs para comprobar solo un lado.

### 10.4 Rollback

- **Falló la aplicación** (errores, latencia, smoke test): vuelve a desplegar los digests guardados
  antes del despliegue. Nunca reconstruyas un commit antiguo para hacer rollback, y nunca reviertas
  una migración.
- **Falló la migración:** la versión en marcha sigue sirviendo; repara la base de datos y resuelve
  la migración ([incident-response.md](incident-response.md#10-failed-database-migration)).
- **Rollback planificado:** ejecuta Deploy con el tag anterior (repite los gates sobre ese commit).

[ci-cd.md](ci-cd.md#rollback) tiene la tabla completa.

## 11. Infraestructura opcional

Encender cada pieza es configuración, y nada de esto hace falta para desarrollar, probar o
desplegar. Dos vienen encendidas en local: Redis ([11.1](#111-redis)) y el correo, contra Mailpit
([11.5](#115-correo)).

### 11.1 Redis

Rate limits compartidos entre instancias, una caché compartida, locks y claims de idempotencia.
Encendido por defecto en local y en el servidor de referencia; la aplicación funciona sin él.

1. `pnpm services:up` (y `pnpm dev`) lo arranca con la base de datos: `127.0.0.1:6389`, la
   contraseña `app` (`REDIS_PORT` y `REDIS_PASSWORD` en el `.env` de la raíz los cambian; después,
   lo mismo en `REDIS_URL`).
2. `apps/api/.env`, desde `.env.example`: `REDIS_URL=redis://:app@localhost:6389`,
   `RATE_LIMIT_STORE=redis`, `CACHE_STORE=redis`, `REDIS_REQUIRED=true`. Sin Redis: borra las
   cuatro.
3. Comprueba: el recuadro de `pnpm dev` muestra `Redis localhost:6389`, el log dice
   `Redis connected (redis://localhost:6389)` y readiness muestra `"redis": "ok"`. Páralo
   (`docker compose stop redis`) para ver el modo degradado (readiness 503, con `REDIS_REQUIRED`) y
   arráncalo (`docker compose start redis`) para ver la recuperación.
4. El servidor de referencia tiene el suyo, con un usuario ACL, solo en su red interna
   ([deploy-vps.md](deploy-vps.md#6-the-files-on-the-server)). En otro sitio (REQUIERE
   CONFIGURACIÓN): un Redis privado con TLS y un usuario ACL, `rediss://` desde el gestor de
   secretos, `REDIS_KEY_PREFIX` por entorno; `REDIS_REQUIRED=true` solo si el producto no puede
   funcionar sin él ([security.md](security.md#redis), [architecture.md](architecture.md#redis)).

### 11.2 Error tracking (Sentry)

1. Crea dos proyectos de Sentry: Node.js (API) y JavaScript de navegador (web).
2. API: `SENTRY_DSN` (gestor de secretos; en local en `apps/api/.env`). Web: `WEB_SENTRY_DSN` en el
   contenedor web (en local, en el entorno de `pnpm dev`). `APP_ENVIRONMENT` en ambos.
3. Comprueba: la línea de arranque dice `error tracking on`; `/app/app-config.json` muestra el DSN;
   la CSP permite el host de ingesta de Sentry.
4. Reglas de alerta en Sentry ([alerting.md](alerting.md)). Lo que nunca se envía:
   [security.md](security.md#error-tracking-data).

### 11.3 Trazas y métricas (OpenTelemetry)

1. En local: `docker compose --profile observability up -d`, después
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` en `apps/api/.env` y reinicia `pnpm dev`.
2. Haz unas cuantas peticiones; Grafana en http://localhost:3001: Dashboards → Application
   ("API service", "API SLOs"), Alerting → Alert rules, Explore → Tempo (trazas), Prometheus
   (métricas).
3. Desplegado (REQUIERE CONFIGURACIÓN): el endpoint del collector o del proveedor, sus credenciales
   en `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER=parentbased_traceidratio` y
   `OTEL_TRACES_SAMPLER_ARG=0.1`. Interruptor de emergencia: `OTEL_SDK_DISABLED=true`.
4. Dashboards y reglas de alerta: los ficheros de `observability/`, importados en tu Grafana y
   cargados en tu Prometheus o Grafana Cloud
   ([observability.md](observability.md#use-them-with-your-backend)); el enrutado según
   [alerting.md](alerting.md).

### 11.4 El stack tipo producción con todo

`.env` de la raíz:

```
JWT_ACCESS_SECRET=<openssl rand -hex 32>
STACK_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318
```

```
docker compose --profile stack --profile observability up --build
```

El sitio en http://localhost:8080 (la app en `/app/`), Grafana en http://localhost:3001; la API usa
el Redis de Compose, como en el servidor de referencia. Para con
`docker compose --profile stack --profile observability down`.

### 11.5 Correo

La API envía correo a través de una bandeja de salida: una funcionalidad escribe el mensaje en la
misma transacción que el cambio que comunica, y un worker dentro de cada instancia de la API lo
entrega por SMTP, con reintentos ([architecture.md](architecture.md#email)). Sin `MAIL_SMTP_URL` el
correo está apagado: no se encola nada, readiness dice `checks.mail: "disabled"` y el resto de la
API funciona.

**En local**, `pnpm dev` arranca Mailpit, un capturador de correo: la API le envía
(`MAIL_SMTP_URL=smtp://localhost:1035`, en `apps/api/.env.example`), nada sale de la máquina, y cada
mensaje está en http://localhost:8035. El recuadro que imprime `pnpm dev` lo muestra en su fila
`Mail`, con lo que dice readiness (`ok`, `degraded`). Comprueba el camino completo:

```
pnpm --filter api mail test --to tu@example.test   # se encola y lo envía la API en marcha
```

y el mensaje aparece en Mailpit. Los mensajes viven en la memoria de Mailpit: `pnpm db:down` los
borra.

**En producción** sirve el servidor SMTP de cualquier proveedor (Amazon SES, Postmark, Resend,
Brevo...). En el entorno de la API ([deploy-vps.md](deploy-vps.md#6-the-files-on-the-server) en un
servidor):

```
MAIL_SMTP_URL=smtps://<usuario>:<contraseña, codificada con %>@<host del proveedor>:465
MAIL_FROM="<Producto> <no-reply@<tu dominio>>"
APP_ORIGIN=https://<tu dominio>
```

o `smtp://...:587`: producción exige STARTTLS en ese caso y rechaza un servidor sin TLS (Mailpit
entre ellos), salvo uno en la propia máquina (`localhost`, `127.0.0.1`, `[::1]`). `APP_ORIGIN` y
`APP_BASE_PATH` (/app) son adonde apuntan los enlaces de los mensajes: nunca el Host de una
petición. Antes del primer mensaje, autentica el dominio remitente en el proveedor (SPF, DKIM,
DMARC): sin ellos los mensajes acaban en spam o se rechazan. Después, con la imagen de la API:

```
docker compose ... run --rm -T api node dist/infrastructure/mail/mail.cli.js test --to <tú>
```

**Operarlo:** `mail status` muestra qué espera, qué falló y por qué (nunca una dirección: los
mensajes se nombran por id; `--to <dirección>` encuentra los mensajes de una dirección);
`mail retry --failed` reenvía los fallidos una vez corregida la causa, cada uno con una validez
nueva (una caída más larga que ella no los descarta; los enlaces empiezan su propia validez al
enviarse). Alertas `ApiMailBacklog` y
`ApiMailDeliveryFailed`, y el runbook: [incident-response.md](incident-response.md#16-email-not-delivered).
Para rotar las credenciales SMTP, crea las nuevas en el proveedor, actualiza `MAIL_SMTP_URL`,
redespliega y después revoca las antiguas; los mensajes que esperaban salen en su siguiente intento.

**Recuperar y cambiar la contraseña.** Con el correo encendido, la página de inicio de sesión
ofrece "Forgot your password?": la persona escribe su dirección, recibe un enlace válido 30
minutos y una sola vez, y elige una contraseña nueva (15 caracteres o más; las reglas:
[security.md](security.md#passwords)). Con la sesión iniciada, la página Account (menú superior) la
cambia pidiendo la actual. En ambos casos se cierran al instante las demás sesiones de la cuenta y
el titular recibe un aviso de que su contraseña cambió. Pruébalo en local: `pnpm dev`, cierra
sesión, "Forgot your password?" con `member@example.com`, y abre el enlace desde Mailpit
(http://localhost:8035). Sin correo el enlace no aparece y las rutas de recuperación responden 503;
cambiarla con la sesión iniciada sigue funcionando.

**Registro público (OPCIONAL).** Con `SIGN_UP_ENABLED=true` (y correo), la página de inicio de
sesión ofrece "Create an account": la persona da un nombre, una dirección y una contraseña, recibe
un enlace válido 24 horas y lo confirma escribiendo esa misma contraseña; solo entonces existe la
cuenta (rol member) y queda con la sesión iniciada. Una dirección que ya tiene cuenta recibe un
aviso en lugar de un enlace, y la página responde igual en ambos casos. `apps/api/.env.example` lo
activa en local; en producción está apagado salvo que lo actives (las cuentas se crean entonces
con `user:create`). Pruébalo: `pnpm dev`, "Create an account" con cualquier dirección, y abre el
enlace desde Mailpit. El diseño y sus límites: [security.md](security.md#sign-up).

**Cambio de correo.** Con el correo encendido, la página Account ofrece también "Change your
email": una dirección nueva y la contraseña actual. Llega un enlace a la dirección nueva y nada
cambia hasta abrirlo; entonces se cierran todas las sesiones (inicia sesión con la dirección nueva)
y la dirección anterior recibe un aviso con un enlace que deshace el cambio durante 7 días, pidiendo
una contraseña nueva. Pruébalo en local con dos direcciones cualesquiera y Mailpit. El diseño:
[security.md](security.md#change-of-email).

**Invitaciones.** Con el correo encendido, los administradores ven "Invitations" en el menú
superior: una dirección y un rol (member o admin) envían un enlace válido 7 días; la persona lo
abre, elige su nombre y contraseña, y queda con la sesión iniciada con ese rol. Las invitaciones
pendientes se pueden reenviar o revocar. Pruébalo en local: inicia sesión como `admin@example.com`,
invita cualquier dirección y abre el enlace desde Mailpit. El diseño:
[security.md](security.md#invitations).

## 12. Operar en producción

| Antes y durante la operación               | Dónde                                                         |
| ------------------------------------------ | ------------------------------------------------------------- |
| La checklist antes de la primera release   | [production-readiness.md](production-readiness.md)            |
| Backups, restores, RPO y RTO               | [disaster-recovery.md](disaster-recovery.md)                  |
| SLOs, error budget, el catálogo de alertas | [alerting.md](alerting.md)                                    |
| Qué significa cada señal                   | [observability.md](observability.md)                          |
| Qué hacer cuando salta una alerta          | [incident-response.md](incident-response.md): 14 runbooks     |
| Capacidad                                  | [load-testing.md](load-testing.md) (OPCIONAL)                 |
| Ajustes de seguridad por proyecto          | [security.md](security.md#per-project-requiere-configuración) |

Lo mínimo antes de recibir tráfico de producción (REQUIERE CONFIGURACIÓN): backups automáticos (en
la base de datos propia del destino VPS, los nocturnos copiados también fuera del servidor,
[deploy-vps.md](deploy-vps.md#backups)) con un simulacro de restore hecho, el job de despliegue con
digests y smoke test, checks de uptime, las alertas CRITICAL dirigidas a alguien, `TRUST_PROXY` para
la topología real, TLS en el borde y la tabla de contactos de incident-response.md rellena.

Ensaya un restore en tu máquina (tarda unos minutos; en Windows, antepón `MSYS_NO_PATHCONV=1`):

```
docker compose exec -T db pg_dump -U app -d app --format=custom --no-owner --no-privileges --file=/tmp/app.dump
docker compose exec -T db createdb -U app app_restore_check
docker compose exec -T db pg_restore -U app -d app_restore_check --no-owner --no-privileges --exit-on-error /tmp/app.dump
DATABASE_URL=postgresql://app:app@localhost:5442/app_restore_check pnpm --filter api exec prisma migrate status
docker compose exec -T db dropdb -U app app_restore_check
docker compose exec -T db rm /tmp/app.dump
```

## 13. Calendario de mantenimiento

| Cuándo                                             | Qué                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cada semana                                        | Revisa y aprueba los pull requests de Dependabot: las actualizaciones patch y minor se mergean solas cuando pasa el CI; las majors y las de workflows las mergeas a mano ([ci-cd.md](ci-cd.md#dependency-updates)). En el destino VPS, si uno cambia `deploy/vps` (la imagen de Caddy, de PostgreSQL o de Redis), copia además los ficheros a cada servidor antes de su siguiente despliegue ([deploy-vps.md](deploy-vps.md#update-the-server-files)). |
| Cada semana (automático)                           | El DAST se ejecuta los lunes: lee los informes de ZAP de las ejecuciones fallidas.                                                                                                                                                                                                                                                                                                                                                                     |
| Cada semana (destino VPS, su propia base de datos) | `backup` sano en `docker compose ps`, y el backup de anoche copiado fuera del servidor ([deploy-vps.md](deploy-vps.md#backups)).                                                                                                                                                                                                                                                                                                                       |
| Cada release                                       | Primero staging, smoke test, después producción con los mismos digests.                                                                                                                                                                                                                                                                                                                                                                                |
| Cada trimestre                                     | Un simulacro de restore con la [checklist](disaster-recovery.md#checklist); una revisión de las alertas (ruido, huecos) y una alerta de prueba por todo el enrutado; un repaso de la política de error budget; lo que Dependabot nunca propone: una major LTS de Node.js (cada octubre), pnpm, las majors de PostgreSQL y Redis ([ci-cd.md](ci-cd.md#keeping-the-stack-current)).                                                                      |
| Cuando sube la cobertura                           | Sube los umbrales en el mismo pull request ([testing.md](testing.md#coverage)).                                                                                                                                                                                                                                                                                                                                                                        |
| Cuando un secreto puede haberse filtrado           | Rótalo de inmediato ([security.md](security.md#secret-rotation)).                                                                                                                                                                                                                                                                                                                                                                                      |
| Después de cada incidente                          | El postmortem, y las actualizaciones del runbook y de las alertas que dejó en evidencia.                                                                                                                                                                                                                                                                                                                                                               |

## 14. Cuando algo falla

Busca unas palabras del mensaje en [troubleshooting.md](troubleshooting.md): lista los mensajes
que imprimen las herramientas, con causa y arreglo, agrupados por instalación, base de datos, API,
infraestructura opcional, quality gates, despliegue, hooks de Git y tests end-to-end. Los primeros
que suelen aparecer:

| Mensaje                                                            | Arreglo                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_UNSUPPORTED_ENGINE`                                      | Node.js 24.15+ ([1.1](#11-instala-las-herramientas))                                                                                                        |
| `port is already allocated` en `pnpm db:up`                        | `DB_PORT=5443` en el `.env` de la raíz y en `DATABASE_URL`                                                                                                  |
| `Environment variable JWT_ACCESS_SECRET is invalid`                | `openssl rand -hex 32` en `apps/api/.env`                                                                                                                   |
| `Cannot reach PostgreSQL at localhost:5442` (tests de integración) | `pnpm services:up`                                                                                                                                          |
| No llega correo a Mailpit (http://localhost:8035)                  | la fila `Mail` del recuadro de `pnpm dev`: `off` (define `MAIL_SMTP_URL`), o un aviso sobre su puerto ([11.5](#115-correo))                                 |
| `Executable doesn't exist ... playwright install`                  | `pnpm exec playwright install chromium`                                                                                                                     |
| `pre-push: Direct pushes to "main" are not allowed`                | haz push de una rama y abre un pull request                                                                                                                 |
| `Could not start Docker` en `pnpm sast` o `pnpm lint:workflows`    | arranca Docker                                                                                                                                              |
| `pnpm sast` tarda muchos minutos                                   | la primera vez descarga la imagen; si no, revisa la CPU y la memoria de Docker y los ficheros grandes sin seguimiento (tarda unos minutos; en CI, unos dos) |

## 15. Apéndice: puertos, cuentas y ficheros

### 15.1 Puertos y URLs

| Puerto | Qué                                                                                                  | Lo arranca                                                   |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 3000   | API (desarrollo)                                                                                     | `pnpm dev`                                                   |
| 5173   | servidor de desarrollo de la web (`/app/`; `pnpm dev` llega a él por el 4321)                        | `pnpm dev`                                                   |
| 4321   | el sitio: la landing, con `/app` y `/api` reenviados (desarrollo); la landing sola (`astro preview`) | `pnpm dev`, `pnpm test:e2e`, `pnpm --filter landing preview` |
| 5442   | PostgreSQL (`DB_PORT`)                                                                               | `pnpm db:up`, `pnpm services:up` (y `pnpm dev`)              |
| 6389   | Redis (`REDIS_PORT`)                                                                                 | `pnpm services:up` (y `pnpm dev`)                            |
| 1035   | SMTP de Mailpit (`MAILPIT_SMTP_PORT`)                                                                | `pnpm services:up` (y `pnpm dev`)                            |
| 8035   | web de Mailpit (`MAILPIT_UI_PORT`)                                                                   | `pnpm services:up` (y `pnpm dev`)                            |
| 3100   | API (tests end-to-end)                                                                               | `pnpm test:e2e`                                              |
| 4173   | web (tests end-to-end, `vite preview`, `/app/`)                                                      | `pnpm test:e2e`, `pnpm --filter web preview`                 |
| 8080   | stack tipo producción (`WEB_PORT`): el sitio, la app en `/app/`                                      | `docker compose --profile stack up`                          |
| 4318   | OTLP/HTTP (`OTLP_HTTP_PORT`)                                                                         | `docker compose --profile observability up -d`               |
| 3001   | Grafana (`GRAFANA_PORT`)                                                                             | `docker compose --profile observability up -d`               |
| 9090   | Prometheus (`PROMETHEUS_PORT`)                                                                       | `docker compose --profile observability up -d`               |

Todos los puertos publicados escuchan solo en 127.0.0.1.

### 15.2 Cuentas

| Cuenta                                   | Dónde                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `admin@example.com` / `admin-password`   | base de datos de desarrollo (`pnpm db:seed`), base de datos end-to-end |
| `member@example.com` / `member-password` | las mismas                                                             |
| PostgreSQL `app` / `app`                 | solo el contenedor de desarrollo                                       |
| Contraseña de Redis `app`                | solo el contenedor de desarrollo                                       |

Son públicas: no las crees nunca en ningún otro sitio.

### 15.3 Dónde está cada cosa

```
apps/api/                 API NestJS
  src/main.ts             punto de entrada (manejadores de crash, telemetría, después el servidor)
  src/env/                la configuración validada
  src/auth/ users/ health/   funcionalidades
  src/common/             filtro de errores, request ids, guard CSRF, cliente HTTP externo, pipes
  src/observability/      redacción, error tracking, telemetría, métricas
  src/infrastructure/     Redis, store de rate limit, caché, locks e idempotencia
  src/lifecycle/          apagado ordenado
  prisma/                 schema.prisma y migraciones
  Dockerfile              imágenes api y api-migrate
apps/web/                 app React
  src/api/                el cliente tipado (schema.d.ts es generado)
  src/auth/               sesión, guards, gestión del refresh
  src/monitoring/         configuración en runtime, error tracking
  nginx/                  configuración del servidor web de producción
  Dockerfile              imagen web
apps/landing/             sitio público con Astro: páginas estáticas en inglés y español
  src/pages/              un fichero por página e idioma (index.astro, es/index.astro, 404)
  src/components/         las secciones; fragments/ dibuja las pantallas de la aplicación
  src/i18n/               todos los textos del sitio, en en.ts y es.ts
  src/styles/global.css   los tokens de diseño (Tailwind CSS)
openapi/openapi.json      el contrato de la API (generado, en git)
e2e/                      tests de Playwright
scripts/                  utilidades del repositorio (comprobaciones, smoke test, imágenes de herramientas)
docs/                     este manual y las guías
infra/terraform/          infraestructura como código: el servidor y la base de datos en DigitalOcean (opcional)
deploy/vps/               el servidor de referencia: sus servicios, despliegue y rollback, roles, backup
.github/                  workflows, rulesets, Dependabot, plantillas, imágenes de herramientas fijadas
docker-compose.yml        base de datos, Redis, Mailpit, servicios opcionales, stack tipo producción
```

### 15.4 Los demás documentos (en inglés)

| Documento                                                                                                                                                                                                                                            | Léelo para                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| [ENGINEERING_STANDARDS.md](../ENGINEERING_STANDARDS.md)                                                                                                                                                                                              | las reglas, en una página                 |
| [CONTRIBUTING.md](../CONTRIBUTING.md), [DEFINITION_OF_DONE.md](../DEFINITION_OF_DONE.md), [definition-of-ready.md](definition-of-ready.md)                                                                                                           | cómo llega un cambio a `main`             |
| [architecture.md](architecture.md), [api-conventions.md](api-conventions.md), [error-handling.md](error-handling.md), [database.md](database.md)                                                                                                     | cómo está organizado el código            |
| [how-to.md](how-to.md)                                                                                                                                                                                                                               | recetas para los cambios habituales       |
| [testing.md](testing.md)                                                                                                                                                                                                                             | tests, cobertura, presupuesto             |
| [security.md](security.md), [authorization.md](authorization.md), [SECURITY.md](../SECURITY.md)                                                                                                                                                      | controles, límites, ajustes por proyecto  |
| [environment.md](environment.md)                                                                                                                                                                                                                     | todas las variables                       |
| [ci-cd.md](ci-cd.md), [branching.md](branching.md), [commits.md](commits.md), [git-hooks.md](git-hooks.md), [code-review.md](code-review.md)                                                                                                         | entrega                                   |
| [observability.md](observability.md), [alerting.md](alerting.md), [incident-response.md](incident-response.md), [disaster-recovery.md](disaster-recovery.md), [load-testing.md](load-testing.md), [production-readiness.md](production-readiness.md) | operación                                 |
| [troubleshooting.md](troubleshooting.md)                                                                                                                                                                                                             | mensajes y arreglos                       |
| [adr/](adr/)                                                                                                                                                                                                                                         | por qué se tomaron las grandes decisiones |
