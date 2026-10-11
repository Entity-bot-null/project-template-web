# Paso a paso: de cero a producción

English version: [step-by-step.md](step-by-step.md). Las dos versiones tienen los mismos pasos; un
cambio en una se hace también en la otra, en el mismo pull request.

Este es el **instructivo**: qué hacer, en orden, desde la información que tienes que reunir antes de
empezar hasta un producto funcionando en producción, y después el ciclo diario. Cada paso dice qué
hacer, el comando exacto, qué deberías ver si funcionó y qué hacer si no funcionó. El
[manual](manual.es.md) explica cómo funciona todo; esta página solo te dice qué hacer a
continuación.

Cómo usar esta guía:

- Sigue las fases en orden. No te saltes ninguna comprobación (**Comprueba**): cada una demuestra
  que los pasos anteriores funcionaron, así un problema aparece donde empieza, no tres fases después.
- Los comandos se ejecutan en una terminal, en la carpeta raíz del proyecto. En Windows usa
  **Git Bash** (se instala con Git for Windows).
- Lo que va entre `<ángulos>` es un valor que sustituyes. Apunta tus valores en la
  [hoja de trabajo](#la-hoja-de-trabajo) a medida que avanzas.
- Marca las casillas (`[ ]` → `[x]`) en tu propia copia si te ayuda.

## La línea de tiempo

| Fase                                                                                  | Con qué terminas                                                            | Tiempo                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| [0. Información y decisiones](#fase-0-información-y-decisiones)                       | la hoja de trabajo rellena, las cuentas creadas                             | 1–2 h, más la espera de las cuentas |
| [1. Tu equipo](#fase-1-tu-equipo)                                                     | todas las herramientas instaladas y comprobadas                             | 30–60 min                           |
| [2. Crea el proyecto](#fase-2-crea-el-proyecto)                                       | tu propia copia, renombrada                                                 | 15 min                              |
| [3. Ejecútalo en local](#fase-3-ejecútalo-en-local)                                   | la app corriendo en tu máquina, con la sesión iniciada                      | 20 min                              |
| [4. Comprueba que pasan todos los gates](#fase-4-comprueba-que-pasan-todos-los-gates) | las mismas comprobaciones que CI, en verde en tu máquina                    | 30–45 min                           |
| [5. Súbelo a GitHub](#fase-5-súbelo-a-github)                                         | el repositorio protegido, CI en verde en un pull request                    | 1 h                                 |
| [6. Hazlo tuyo](#fase-6-hazlo-tuyo)                                                   | el nombre, el diseño y las primeras funcionalidades de tu producto          | de días a semanas                   |
| [7. Servidores de producción](#fase-7-servidores-de-producción)                       | servidores de staging y producción, bases de datos y dominios listos        | 2–3 h por entorno                   |
| [8. El primer despliegue](#fase-8-el-primer-despliegue)                               | la app en marcha en staging, después en producción; el primer administrador | 1 h                                 |
| [9. Monitorización y alertas](#fase-9-monitorización-y-alertas)                       | los errores reportados, el uptime vigilado, alguien recibe las alertas      | 1–2 h                               |
| [10. Antes de los usuarios reales](#fase-10-antes-de-los-usuarios-reales)             | la checklist de preparación para producción, firmada                        | medio día                           |
| [11. El ciclo diario](#fase-11-el-ciclo-diario)                                       | cómo llega cada cambio de la idea a producción                              | cada día                            |
| [12. El calendario de mantenimiento](#fase-12-el-calendario-de-mantenimiento)         | qué hacer cada semana, cada mes y cada trimestre                            | recurrente                          |

---

## Fase 0. Información y decisiones

Todavía no hay nada que instalar. Reúne esto primero: la mayoría de los retrasos vienen de una
cuenta o de una decisión que nadie tenía cuando hizo falta.

### 0.1 Decide

- [ ] **Nombre del producto** (el que ven los usuarios) y **nombre del repositorio** (en
      minúsculas, con guiones: `acme-portal`).
- [ ] **Dominios**: uno para producción (`app.acme.com`) y otro para staging (`staging.acme.com`).
      Necesitas acceso a los ajustes de DNS del dominio.
- [ ] **Dónde se ejecuta.** Esta guía usa el destino listo para usar: **un servidor Linux por
      entorno** con Docker y un PostgreSQL gestionado ([deploy-vps.md](deploy-vps.md)). Sirve para
      un primer producto (una sola instancia de la API). Para Kubernetes o una plataforma de
      contenedores, las fases 0–6 son iguales y la fase 7 la sustituye tu plataforma
      ([ci-cd.md](ci-cd.md#deployment)).
- [ ] **Quién** aprueba los despliegues a producción (al menos una persona además del autor), quién
      revisa el código (CODEOWNERS), quién recibe los reportes de seguridad y las alertas.
- [ ] **Lo que la plantilla no decide por ti** (escribe la respuesta, aunque sea "más adelante"):
      cómo consiguen los usuarios una cuenta (registro, invitaciones, SSO), la recuperación de
      contraseña, los roles además de `member` y `admin`, el idioma y el diseño de la interfaz.

### 0.2 Crea las cuentas

| Cuenta                                                  | Para                                          | Notas                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub (mejor una organización que una cuenta personal) | código, CI, imágenes, despliegues             | Un repositorio **privado** necesita **GitHub Team** (organización) o **Pro** (personal): de ello dependen los entornos con revisores obligatorios y sus secretos, los rulesets y la protección de ramas. En el plan Free solo existen para repositorios públicos |
| Un proveedor cloud o de VPS                             | los servidores (2 vCPU, 4 GB de RAM cada uno) | cualquier proveedor con Ubuntu 24.04 y una IPv4 pública                                                                                                                                                                                                          |
| Un PostgreSQL gestionado                                | las bases de datos (16 o posterior)           | a menudo el mismo proveedor; backups automáticos y point-in-time recovery obligatorios                                                                                                                                                                           |
| El DNS del dominio                                      | registros `A` hacia los servidores            | el registrador o un servicio de DNS                                                                                                                                                                                                                              |
| Sentry (opcional)                                       | informes de errores de la API y del navegador | el plan gratuito basta para empezar                                                                                                                                                                                                                              |
| Un monitor de uptime (opcional pero recomendado)        | una alerta cuando el sitio está caído         | cualquier servicio que compruebe una URL desde varios lugares                                                                                                                                                                                                    |
| Un gestor de contraseñas                                | los secretos de esta guía                     | una bóveda compartida para el equipo                                                                                                                                                                                                                             |

### La hoja de trabajo

Copia esto en tu gestor de contraseñas o en tus notas y rellénalo a medida que avanzas. Los secretos
van solo en el gestor de contraseñas.

| Dato                                                       | Valor                 | Fase |
| ---------------------------------------------------------- | --------------------- | ---- |
| Nombre del producto                                        |                       | 0    |
| Propietario / repositorio de GitHub                        | `OWNER/REPO`          | 0    |
| Dominio de producción / dominio de staging                 |                       | 0    |
| IP del servidor de producción / IP del servidor de staging |                       | 7    |
| Host de la base de datos (producción / staging)            |                       | 7    |
| Contraseña de `app_migrator` (por entorno)                 | gestor de contraseñas | 7    |
| Contraseña de `app_runtime` (por entorno)                  | gestor de contraseñas | 7    |
| `JWT_ACCESS_SECRET` (por entorno, y uno para tu máquina)   | gestor de contraseñas | 3, 7 |
| Clave SSH de despliegue (por entorno)                      | gestor de contraseñas | 7    |
| `RELEASE_PLEASE_TOKEN` (opcional)                          | gestor de contraseñas | 5    |
| DSNs de Sentry (API, web)                                  |                       | 9    |
| Email del primer administrador                             |                       | 8    |

**Comprueba:** todas las cuentas de arriba existen y puedes iniciar sesión en cada una; las
decisiones de 0.1 tienen respuesta.

---

## Fase 1. Tu equipo

### 1.1 Instala las herramientas

| Herramienta        | Instalación                                                                                                                                                                | Comando de comprobación  | Esperado                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Git                | Windows: [Git for Windows](https://git-scm.com/download/win) (incluye Git Bash y `openssl`); macOS: `xcode-select --install`; Linux: tu gestor de paquetes                 | `git --version`          | cualquier versión actual                                                  |
| Node.js 24         | [nvm](https://github.com/nvm-sh/nvm) (macOS/Linux): `nvm install 24`; Windows: [fnm](https://github.com/Schniz/fnm) o el [instalador oficial](https://nodejs.org) (24 LTS) | `node --version`         | `v24.15.0` o posterior                                                    |
| pnpm               | `corepack enable` (una vez; viene con Node.js)                                                                                                                             | `pnpm --version`         | `12.5.1` (dentro del proyecto)                                            |
| Docker             | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS) o Docker Engine (Linux)                                                                 | `docker compose version` | `Docker Compose version v2…`                                              |
| GitHub CLI         | [cli.github.com](https://cli.github.com)                                                                                                                                   | `gh --version`           | cualquier versión actual                                                  |
| VS Code (sugerido) | [code.visualstudio.com](https://code.visualstudio.com)                                                                                                                     |                          | la primera vez que abres el proyecto, ofrece sus extensiones recomendadas |

**Comprueba:** cada comando de comprobación imprime el valor esperado. Docker Desktop está arrancado
(su icono muestra "Docker Desktop is running").

**Si falla:**

- `node` imprime una versión anterior: `nvm use 24` / `fnm use 24`, y después abre una terminal
  nueva.
- `pnpm` no se encuentra: ejecuta otra vez `corepack enable` en una terminal abierta como
  administrador (Windows) o con `sudo` (macOS/Linux).
- `docker compose version` falla: arranca Docker Desktop y espera hasta que diga que está en marcha.

### 1.2 Inicia sesión en GitHub desde la terminal

```
gh auth login
```

Elige GitHub.com, HTTPS, e inicia sesión con el navegador.

**Comprueba:** `gh auth status` dice `Logged in to github.com account <tu usuario>`.

### 1.3 Configura Git (una vez por equipo)

```
git config --global user.name "<Tu Nombre>"
git config --global user.email "<tu@acme.com>"
git config --global init.defaultBranch main
```

**Comprueba:** `git config --global --list` muestra los tres valores.

---

## Fase 2. Crea el proyecto

### 2.1 Crea tu repositorio desde la plantilla

Lo más fácil: en GitHub, abre el repositorio de la plantilla, **Use this template → Create a new
repository**, propietario `OWNER`, nombre `REPO`, **Private**. Después clónalo:

```
gh repo clone OWNER/REPO
cd REPO
```

Sin la función de plantillas de GitHub (una copia de la carpeta sin su historial):

```
git clone --depth 1 <URL del repositorio de la plantilla> REPO
cd REPO
rm -rf .git
git init -b main
```

**Comprueba:** `ls` muestra `apps`, `docs`, `package.json`, `docker-compose.yml`.

### 2.2 Renombra los marcadores de la plantilla

Abre el proyecto en tu editor (`code .`) y cambia:

| Fichero                           | Cambio                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `package.json` (raíz)             | `"name"` → `REPO`, `"description"` → una frase sobre el producto                     |
| `README.md`                       | el título y el primer párrafo                                                        |
| `apps/web/index.html`             | `<title>`, `<meta name="description">`, `<html lang="…">` (el idioma de tu interfaz) |
| `apps/api/src/openapi/openapi.ts` | `.setTitle('API')` → `.setTitle('<Producto> API')`                                   |
| `SECURITY.md`                     | `security@example.com` → tu contacto de seguridad                                    |
| `.github/CODEOWNERS`              | sustituye `@your-org/...` por usuarios o equipos reales y quita el `#`               |
| `CHANGELOG.md`                    | deja solo el título `# Changelog`: la historia de la plantilla no es la tuya         |

Los paquetes `apps/api` y `apps/web` conservan sus nombres (`api`, `web`): son privados.

**Comprueba:** al buscar `example.com` en el proyecto solo aparecen ficheros `.env.example`, tests y
ejemplos de la documentación; al buscar `REQUIERE CONFIGURACIÓN` aparecen los puntos que siguen
pendientes (la mayoría están en fases posteriores).

---

## Fase 3. Ejecútalo en local

### 3.1 Instala las dependencias

```
corepack enable
pnpm install
```

**Comprueba:** termina con `Done in …`, y `git config core.hooksPath` imprime `.husky/_` (los hooks
de Git están instalados).

**Si falla:** `ERR_PNPM_UNSUPPORTED_ENGINE` → Node.js es anterior a 24.15 (fase 1).
`ERR_PNPM_NO_MATURE_MATCHING_VERSION` → una dependencia se publicó hace menos de siete días (la
política de supply chain): espera un día o consulta [troubleshooting.md](troubleshooting.md).

### 3.2 Crea tu configuración local

```
cp apps/api/.env.example apps/api/.env
openssl rand -hex 32
```

Abre `apps/api/.env` y pega el valor impreso después de `JWT_ACCESS_SECRET=`. En local no hace
falta nada más.

**Comprueba:** `grep JWT_ACCESS_SECRET apps/api/.env` muestra un valor de 64 caracteres.
`git status` **no** lista `apps/api/.env` (está ignorado: nunca hagas commit de él).

### 3.3 Arranca la base de datos

```
pnpm db:up
pnpm db:migrate
pnpm db:seed
```

**Comprueba:** `db:up` termina con `Container … Healthy`; `db:migrate` dice que se aplicaron las
migraciones; `db:seed` imprime las dos cuentas de desarrollo:

```
admin   admin@example.com / admin-password
member  member@example.com / member-password
```

**Si falla:** `port is already allocated` (habitual en Windows: el puerto 5432 está reservado) →
crea el `.env` de la raíz con `cp .env.example .env`, pon `DB_PORT=5442` en él, cambia el puerto de
`DATABASE_URL` en `apps/api/.env` a `5442` y repite.

### 3.4 Arranca la app

```
pnpm dev
```

**Comprueba**, en tu navegador:

| Abre                                                                          | Deberías ver                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| http://localhost:5173                                                         | la página de inicio de sesión                           |
| inicia sesión como `admin@example.com` / `admin-password`                     | la app, con la sesión iniciada como Admin               |
| cierra la sesión, inicia sesión como `member@example.com` / `member-password` | la app como Member, sin las pantallas de administración |
| http://localhost:3000/api/docs                                                | la documentación de la API (Swagger)                    |
| http://127.0.0.1:3000/api/health/ready                                        | una respuesta JSON con `"status":"ok"`                  |

La terminal muestra la primera línea de la API:
`Starting release unversioned in development: … error tracking off, Redis off`.

Para con `Ctrl+C`. Mañana basta con `pnpm dev`.

---

## Fase 4. Comprueba que pasan todos los gates

Ejecútalo una vez ahora: si tu máquina pasa lo que ejecuta CI, un CI en rojo más adelante significa
un problema real en un cambio, no un problema de configuración.

### 4.1 El gate principal

```
pnpm verify
```

Ejecuta, en orden: formato, lint, tipos, tests unitarios y de componentes con cobertura, las
comprobaciones de seguridad (vulnerabilidades, licencias, secretos), el build y el presupuesto de
rendimiento. Tarda unos minutos.

**Comprueba:** termina sin errores; aparece el resumen de cobertura y las líneas del presupuesto
dicen `ok`.

### 4.2 Tests de integración y de navegador

```
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

**Comprueba:** los dos informan de que pasaron todos los tests (`passed`, ningún `failed`). Los
tests end-to-end usan los puertos 3100 y 4173: para `pnpm dev` antes.

### 4.3 Las comprobaciones con Docker

```
pnpm sast
pnpm lint:workflows
pnpm observability:check
```

**Comprueba:** Semgrep termina con `0 findings`; la comprobación de los workflows imprime
`No findings to report`; la de observabilidad imprime una línea que empieza por `ok` (dashboards,
alertas, nombres de métricas) y después el `SUCCESS` de promtool en cada uno de sus pasos.
`pnpm sast` tarda unos minutos (analiza una copia temporal de los ficheros que git versiona); la
primera vez también descarga la imagen de Semgrep.

### 4.4 Las imágenes de producción en tu máquina

Añade un secreto para el stack de producción local al `.env` de la raíz (créalo con
`cp .env.example .env` si no lo has hecho):

```
echo "JWT_ACCESS_SECRET=$(openssl rand -hex 32)" >> .env
docker compose --profile stack up --build
```

En una segunda terminal:

```
pnpm smoke --url http://localhost:8080
```

**Comprueba:** el smoke test termina con `Smoke test passed (public URL only).` y
http://localhost:8080 muestra la app (con una base de datos vacía: sin cuentas, que es lo
esperado).

Páralo: `Ctrl+C`, y después `docker compose --profile stack down`.

---

## Fase 5. Súbelo a GitHub

### 5.1 Primer commit y push

Si creaste el repositorio con **Use this template**, ya tiene un remoto. Si no:

```
gh repo create OWNER/REPO --private --source . --remote origin
```

Después:

```
git add -A
git commit -m "chore: start from the project template"
git push --no-verify -u origin main
```

El primer commit pasa las comprobaciones de pre-commit por todos los ficheros (alrededor de un
minuto). `--no-verify` es solo para este primer push: a partir de ahora el hook rechaza los pushes a
`main`.

**Comprueba:** el repositorio en GitHub muestra tus ficheros; la pestaña **Actions** muestra una
ejecución de **CI** en `main` (debería terminar en verde).

### 5.2 Ajustes del repositorio

En GitHub → **Settings**:

1. **General → Pull Requests**: permite solo **squash merging**; mensaje de commit por defecto
   "**Pull request title**"; marca **Automatically delete head branches**.
2. **Actions → General → Workflow permissions**: **Read repository contents and packages
   permissions**, y marca **Allow GitHub Actions to create and approve pull requests** (el
   workflow **Release** abre el pull request de release con el token del workflow).
3. **Environments → New environment** `staging`: **Deployment branches and tags → Selected
   branches and tags → Add rule `main`**.
4. **Environments → New environment** `production`: la misma regla para `main`, y **Required
   reviewers** (las personas de 0.1; marca **Prevent self-review**).
5. **Code security**: activa **Dependabot alerts**, **Dependabot security updates**, **Secret
   scanning** con **Push protection** (si tu plan los ofrece), **Private vulnerability
   reporting**.
6. **Rules → Rulesets**: importa los dos ficheros, o con la CLI:

   ```
   gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/main.json
   gh api repos/OWNER/REPO/rulesets --method POST --input .github/rulesets/tags.json
   ```

   Los rulesets necesitan un repositorio público o GitHub Team. Con GitHub Pro (una cuenta
   personal), usa en su lugar **Branches → Add branch protection rule** para `main`: exige un pull
   request con una aprobación y los status checks **CI passed** y **Conventions**. En el plan Free
   con un repositorio privado no está disponible nada de esto (ni ninguno de los entornos de los
   pasos 3–4): haz público el repositorio o cambia a un plan superior antes de seguir; si no, las
   protecciones de esta guía solo existen sobre el papel. Dos workflows compensan una parte en
   cualquier plan: `main-guard.yml` avisa de un push a `main` que no es un pull request mergeado, y
   `dependabot-auto-merge.yml` comprueba él mismo la aprobación y el CI. Nada reemplaza a los
   revisores obligatorios de un despliegue ([ci-cd.md](ci-cd.md#required-check)).

**Comprueba:** **Settings → Environments** lista `staging` y `production`, los dos limitados a
`main`; **Rules** (o la protección de ramas) muestra la regla de `main`.

### 5.3 El token para los pull requests de release

Opcional, el token de release: sin él, el workflow **Release** lanza él mismo el CI en el pull
request de release, y la comprobación de convenciones (**CI passed** y **Conventions**, los dos
checks que pide el ruleset). Con un token de una GitHub App o un **fine-grained personal access
token**, guardado como `RELEASE_PLEASE_TOKEN`, el pull request de release ejecuta todos los
workflows de pull request, como el de una persona ([ci-cd.md](ci-cd.md#release-pull-requests)). El
token fine-grained:

1. GitHub → tu avatar → **Settings → Developer settings → Personal access tokens → Fine-grained
   tokens → Generate new token**.
2. Resource owner `OWNER`; **Only select repositories** → `REPO`; la caducidad que diga tu
   política.
3. Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**,
   **Issues: Read and write**.
4. Genéralo, cópialo y después:

   ```
   gh secret set RELEASE_PLEASE_TOKEN
   ```

   y pégalo cuando te lo pida.

**Comprueba:** si configuraste el token de release, `gh secret list` muestra
`RELEASE_PLEASE_TOKEN`; apunta su fecha de caducidad en el
[calendario de mantenimiento](#fase-12-el-calendario-de-mantenimiento).

### 5.4 Comprueba el flujo de pull request

```
git switch -c chore/check-pipeline
printf '\nBuilt from the web template.\n' >> README.md
git commit -am "docs: check the pipeline"
git push -u origin HEAD
gh pr create --fill
gh pr checks --watch
```

**Comprueba:** el pull request muestra **CI passed** en verde (unos 15 minutos la primera vez) y,
con el ruleset, no se puede mergear sin una aprobación. Mergéalo (**Squash and merge**).

Un cambio `docs` o `chore` no publica nada, así que aún no aparece ningún pull request de release:
el workflow **Release** abre uno cuando el primer `feat` o `fix` llega a `main`, y lanza en él el CI
y Conventions (**CI passed** y **Conventions** en verde en ese pull request unos minutos después).
Déjalo abierto: mergéalo cuando quieras publicar tu primera release (fase 8).

---

## Fase 6. Hazlo tuyo

A partir de aquí, cada cambio sigue [el ciclo diario](#fase-11-el-ciclo-diario): una rama, un pull
request, CI, revisión, merge. Los primeros suelen ser:

1. **Diseño e idioma.** `apps/web/src/index.css` contiene estilos provisionales; los textos de las
   pantallas están en `apps/web/src`. Sustitúyelos por los del producto.
2. **Tu dominio de negocio** (los datos y las reglas de tu producto, no el dominio web). Añade tus tablas y tus módulos de la API junto a `users`, siguiendo las recetas:
   [how-to.md](how-to.md) (añadir una tabla, un módulo de la API, un endpoint, una pantalla, un
   rol, una variable de entorno).
3. **Cómo se crean las cuentas.** La plantilla tiene inicio de sesión, sesiones y roles, pero no
   registro, invitaciones ni recuperación de contraseña: implementa lo que se decidió en 0.1. Hasta
   entonces, las cuentas se crean con el comando `create-user`
   ([fase 8](#84-crea-el-primer-administrador)).
4. **Servicios opcionales**, solo si hacen falta: Redis (más de una instancia de la API),
   OpenTelemetry (trazas y métricas): [manual.es.md](manual.es.md#11-infraestructura-opcional).

**Comprueba, en cada cambio:** `pnpm verify` pasa en local y **CI passed** está en verde en su pull
request.

Puedes desplegar en staging mucho antes de que el producto esté terminado: haz las fases 7 y 8
pronto, para que cada cambio mergeado se pueda probar en un servidor real.

---

## Fase 7. Servidores de producción

Haz esta fase dos veces: una para **staging** y otra para **producción**. Los comandos usan
`app.acme.com`; usa el dominio del entorno que estás configurando.

Los pasos 7.1 a 7.5 construyen el servidor y la base de datos a mano, con cualquier proveedor. En
DigitalOcean, Terraform puede construir los mismos: haz el 7.0, sáltate del 7.1 al 7.5 y sigue en
el 7.6.

### 7.0 En DigitalOcean, del 7.1 al 7.5 con Terraform (opcional)

Qué crea Terraform, cuánto cuesta y por qué:
[deploy-vps.md](deploy-vps.md#provision-with-terraform-digitalocean). Necesitas Terraform 1.16
([developer.hashicorp.com/terraform/install](https://developer.hashicorp.com/terraform/install);
`terraform version` imprime `Terraform v1.16.` y el número de parche) y un token de la API de
DigitalOcean con permiso de escritura (**API → Tokens**).

En tu equipo, la clave de despliegue de este entorno (como en el 7.4) y después el fichero de
ajustes:

```
ssh-keygen -t ed25519 -N "" -C "github-deploy-production" -f deploy_production
cd infra/terraform/digitalocean
cp terraform.tfvars.example production.tfvars
```

Edita `production.tfvars`: `project_name`, `environment`, `domain`, tu clave pública SSH
(`admin_ssh_public_key`, el contenido de tu `~/.ssh/id_ed25519.pub`), el contenido de
`deploy_production.pub` (`deploy_ssh_public_key`) y `alert_emails` (miembros verificados de tu
equipo de DigitalOcean). Deja `admin_cidrs = ["0.0.0.0/0"]`: los runners de GitHub se conectan por
SSH desde direcciones que cambian. Después (pega el token cuando `read` espere, y pulsa Enter):

```
read -rs DIGITALOCEAN_TOKEN && export DIGITALOCEAN_TOKEN
terraform init
terraform workspace new production
terraform plan -var-file=production.tfvars -out=production.tfplan
terraform apply production.tfplan
rm production.tfplan
ssh "$(terraform output -raw ssh_admin)" cloud-init status --wait
```

La primera conexión SSH pregunta si confías en la clave del servidor: compara su huella con la que
muestra el servidor en la **Droplet Console** de DigitalOcean (entra como `ops` y ejecuta
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Después apunta el dominio al servidor, salvo
que lo haya hecho `manage_dns = true`: el registro que muestra `terraform output dns_record`, en
tu proveedor de DNS. Por último, los roles de la base de datos y la clave del servidor para GitHub:

```
cd ../../..
pnpm iac:database
ssh-keyscan -t ed25519 app.acme.com > known_hosts_production
```

**Comprueba:** `cloud-init status --wait` termina con `status: done`; `pnpm iac:database` termina
con `Done: the database app (owner app_migrator) and the role app_runtime.`;
`ssh -i deploy_production deploy@app.acme.com 'docker ps'` imprime una tabla vacía (solo las
cabeceras); `ssh-keygen -lf known_hosts_production` muestra la huella que comparaste.

**Si falla:**

| Mensaje                                              | Causa y solución                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401`, `Unable to authenticate you`                  | `DIGITALOCEAN_TOKEN` no está exportado en esta terminal, o el token no puede escribir                                                                                                                                                     |
| `Invalid value for variable`                         | el valor que nombra en `production.tfvars`; `variables.tf` dice qué acepta cada uno                                                                                                                                                       |
| `SSH Key is already in use on your account`          | esta clave de despliegue ya está en DigitalOcean (otro entorno, un intento anterior): una clave de despliegue por entorno, o borra la antigua allí (**Settings → Security**)                                                              |
| `Provider produced inconsistent result after apply`  | la nueva IP reservada tardó en aparecer en la API de DigitalOcean: `terraform import -var-file=production.tfvars digitalocean_reserved_ip.app <dirección>` (la dirección en **Networking → Reserved IPs**), después plan y apply de nuevo |
| `The workspace (...) is not the environment (...)`   | `terraform workspace select production`                                                                                                                                                                                                   |
| `status: error`                                      | `/var/log/cloud-init-output.log` en el servidor dice qué comando falló                                                                                                                                                                    |
| `pnpm iac:database`: `Permission denied (publickey)` | tu clave SSH no es la de `admin_ssh_public_key`                                                                                                                                                                                           |

### 7.1 Crea el servidor

En la consola de tu proveedor: un servidor con **Ubuntu 24.04 LTS**, 2 vCPU y 4 GB de RAM o más,
una IPv4 pública y tu clave pública SSH personal para el primer acceso. Si el proveedor tiene
firewall, permite TCP 22, 80 y 443, y UDP 443.

**Comprueba:** `ssh root@<IP del servidor>` (o el usuario que indique el proveedor) abre una shell
en el servidor.

### 7.2 Apunta el dominio al servidor

En tu proveedor de DNS: un registro **A** `app.acme.com` → la IPv4 del servidor. Ningún registro
**AAAA**: el despliegue sirve solo IPv4 ([deploy-vps.md](deploy-vps.md#2-create-the-server) explica
por qué).

**Comprueba**, después de unos minutos: `nslookup app.acme.com` responde con la dirección del
servidor.

### 7.3 Instala Docker y cierra el firewall

Conectado al servidor, copia estas líneas, un bloque cada vez:

```
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

```
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw --force enable
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

**Comprueba:** `docker compose version` imprime `Docker Compose version v2…`; `sudo ufw status`
lista OpenSSH, 80 y 443 como `ALLOW`.

### 7.4 Crea el usuario de despliegue

En el servidor:

```
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo install -d -m 755 -o deploy -g deploy /srv/app
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
```

En **tu equipo**, una clave para que GitHub se conecte (una por entorno; sin frase de contraseña):

```
ssh-keygen -t ed25519 -N "" -C "github-deploy-production" -f deploy_production
scp deploy_production.pub <tu usuario>@app.acme.com:/tmp/deploy.pub
ssh <tu usuario>@app.acme.com 'sudo install -m 600 -o deploy -g deploy /tmp/deploy.pub /home/deploy/.ssh/authorized_keys && rm /tmp/deploy.pub'
ssh-keyscan -t ed25519 app.acme.com > known_hosts_production
```

**Comprueba:** `ssh -i deploy_production deploy@app.acme.com 'docker ps'` imprime una tabla vacía
(solo las cabeceras). Compara la clave de `known_hosts_production` con la clave de host que muestra
la consola de tu proveedor (o ejecuta `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` en el
servidor y `ssh-keygen -lf known_hosts_production` en tu equipo: las huellas tienen que coincidir).

### 7.5 Crea la base de datos

En la consola de tu proveedor, un **PostgreSQL 16 o posterior** gestionado: en la misma región que
el servidor, con **backups automáticos** y **point-in-time recovery** activados, **protección contra
borrado** (deletion protection) activada, y acceso solo desde la IP del servidor (o una red
privada). Apunta su nombre de host.

Genera dos contraseñas (`openssl rand -hex 24`, dos veces) y guárdalas en el gestor de contraseñas.
Después, conectado como el administrador del proveedor
(`psql "<cadena de conexión del administrador>"`):

```sql
CREATE ROLE app_migrator LOGIN PASSWORD '<contraseña de app_migrator>';
GRANT app_migrator TO CURRENT_USER;
CREATE DATABASE app OWNER app_migrator;
CREATE ROLE app_runtime LOGIN PASSWORD '<contraseña de app_runtime>' CONNECTION LIMIT 50;
```

Después, conectado **como `app_migrator`** a la base de datos `app`
(`psql "postgresql://app_migrator:<contraseña de app_migrator>@<host>:5432/app?sslmode=require"`):

```sql
GRANT CONNECT ON DATABASE app TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
```

**Comprueba:** cada sentencia responde `CREATE ROLE`, `GRANT ROLE`, `CREATE DATABASE`, `GRANT` o
`ALTER DEFAULT PRIVILEGES`, sin errores. Sin `GRANT app_migrator TO CURRENT_USER`, PostgreSQL 16 y
posteriores rechazan `CREATE DATABASE` (`must be able to SET ROLE "app_migrator"`): los
administradores de los proveedores no son superusuarios. El migrador será el propietario del
esquema y quien lo cambie; la API se conecta como `app_runtime`, que solo lee y escribe datos.

### 7.6 Copia los ficheros de despliegue al servidor

Desde la carpeta del proyecto en tu equipo:

```
scp deploy/vps/* deploy@app.acme.com:/srv/app/
```

Más adelante, cuando una release cambie alguno de estos ficheros (Dependabot actualiza la imagen de
Caddy en `deploy/vps`), el workflow Deploy se detiene en **Check the server's deploy files** hasta
que los vuelvas a copiar ([deploy-vps.md](deploy-vps.md#update-the-server-files)).

En el servidor, como `deploy` (`ssh -i deploy_production deploy@app.acme.com`):

```
cd /srv/app
chmod 755 deploy.sh rollback.sh
cp server.env.example server.env
cp api.env.example api.env
cp migrate.env.example migrate.env
cp web.env.example web.env
chmod 600 api.env migrate.env
openssl rand -hex 32
```

Edita cada fichero (`nano <fichero>`, guarda con `Ctrl+O`, sal con `Ctrl+X`):

| Fichero       | Define                                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.env`  | `APP_DOMAIN=app.acme.com`                                                                                                                                                                                                                                   |
| `api.env`     | `DATABASE_URL=postgresql://app_runtime:<contraseña de app_runtime>@<host de la base de datos>:5432/app?sslmode=require`, `JWT_ACCESS_SECRET=<el valor que imprimió openssl>`, `APP_ENVIRONMENT=production` (o `staging`), `APP_ORIGIN=https://app.acme.com` |
| `migrate.env` | `DATABASE_URL=postgresql://app_migrator:<contraseña de app_migrator>@<host de la base de datos>:5432/app?sslmode=require`                                                                                                                                   |
| `web.env`     | `APP_ENVIRONMENT=production` (o `staging`)                                                                                                                                                                                                                  |

Con Terraform (7.0), los dos valores de `DATABASE_URL` ya están completos: en
`infra/terraform/digitalocean` en tu equipo, `terraform output -raw database_runtime_url`
(`api.env`) y `terraform output -raw database_migrator_url` (`migrate.env`).

En DigitalOcean o Amazon RDS, cuyos certificados vienen de la CA propia del proveedor, termina las
dos URL con `?sslmode=require&uselibpqcompat=true` (las salidas de Terraform ya lo hacen): si no,
la API rechaza el certificado (un error de certificado como
`self-signed certificate in certificate chain`,
[deploy-vps.md](deploy-vps.md#6-the-files-on-the-server)).

**Comprueba:** `ls -l /srv/app` muestra `api.env` y `migrate.env` como `-rw-------` (solo `deploy`
puede leerlos), y `grep -c '<' *.env` imprime `0` para cada fichero (no queda ningún marcador).

### 7.7 Dale a GitHub los datos del servidor

Una vez para el repositorio:

```
gh variable set DEPLOY_TARGET --body vps
gh variable set IMAGE_PREFIX --body ghcr.io/<owner>/<repo>
```

(`IMAGE_PREFIX` en minúsculas: `ghcr.io/acme/acme-portal`.)

Para el entorno que estás configurando (aquí `production`; `staging` la otra vez):

```
gh variable set DEPLOY_HOST --env production --body app.acme.com
gh variable set PUBLIC_URL --env production --body https://app.acme.com
gh secret set DEPLOY_SSH_KEY --env production < deploy_production
gh secret set DEPLOY_KNOWN_HOSTS --env production < known_hosts_production
```

Guarda `deploy_production` en el gestor de contraseñas, y después bórralo de tu equipo junto con
`known_hosts_production`.

**Comprueba:** **Settings → Environments → production** lista las variables `DEPLOY_HOST`,
`PUBLIC_URL` y los secretos `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`; **Settings → Secrets and
variables → Actions → Variables** lista `DEPLOY_TARGET` e `IMAGE_PREFIX`.

Ahora repite la fase para el otro entorno: 7.0 o 7.1–7.5, y después 7.6 y 7.7.

---

## Fase 8. El primer despliegue

### 8.1 Despliega en staging

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=main
gh run watch
```

Tarda 15–25 minutos la primera vez. Los jobs, en orden: Resolve the commit → Gates → Publish
api / api-migrate / web → Release to staging (server).

**Comprueba:** la ejecución termina en verde; su resumen lista los tres digests de las imágenes; el
último paso imprime `Smoke test passed (public URL only).`; https://staging.acme.com abre la página
de inicio de sesión con un certificado válido (el candado).

**Si falla:**

| Paso que falla                                              | Causa y arreglo                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gates                                                       | lo mismo que un CI en rojo: abre el log del job que falla ([troubleshooting.md](troubleshooting.md))                                                                                              |
| Publish: "The registry is ghcr.io"                          | `IMAGE_PREFIX` tiene que ser `ghcr.io/<owner>/<repo>` en minúsculas (7.7)                                                                                                                         |
| Publish: "Scan the pushed image"                            | un aviso HIGH o CRITICAL con arreglo en la imagen publicada, como en el escaneo de imágenes de los gates: actualiza la imagen base o la dependencia ([security.md](security.md#container-images)) |
| Environment settings                                        | falta una variable o un secreto del entorno (7.7)                                                                                                                                                 |
| Deploy on the server: `Permission denied (publickey)`       | la clave pública no está en `/home/deploy/.ssh/authorized_keys`, o `DEPLOY_SSH_KEY` tiene la clave privada equivocada (7.4)                                                                       |
| `Host key verification failed`                              | `DEPLOY_KNOWN_HOSTS` no coincide con el servidor (7.4)                                                                                                                                            |
| Check the server's deploy files: "Server files out of date" | una release cambió un fichero de `deploy/vps`: vuelve a copiarlos ([deploy-vps.md](deploy-vps.md#update-the-server-files))                                                                        |
| `server.env is missing`                                     | 7.6 no se hizo en ese servidor                                                                                                                                                                    |
| The migration failed                                        | `migrate.env`: contraseña o host equivocados, o la base de datos no es accesible desde el servidor (7.5)                                                                                          |
| The rollout failed                                          | el log del paso termina con las últimas líneas de log de los contenedores nuevos, y después la release anterior vuelve a arrancar; normalmente es `api.env` (`DATABASE_URL`, `JWT_ACCESS_SECRET`) |
| Smoke test, errores de certificado                          | el DNS todavía no apunta al servidor, o los puertos 80/443 están cerrados (7.2, 7.3)                                                                                                              |

### 8.2 Míralo

Abre https://staging.acme.com. La página de inicio de sesión carga; nadie puede iniciar sesión
todavía: las bases de datos de producción no tienen cuentas.

### 8.3 Publica la primera release y despliégala en producción

1. Mergea el pull request de release, "chore(main): release <versión>" (5.4: existe en cuanto un
   `feat` o un `fix` llega a `main`). La versión sale de los commits desde el `1.0.0` de la
   plantilla: el primer `fix` la convierte en 1.0.1, el primer `feat` en 1.1.0. Para elegir la
   primera versión, mergea antes un pull request añadiendo el pie `Release-As: <versión>` a su
   mensaje de commit en el diálogo de **Squash and merge**. Si el pull request de release ofrece
   **Update branch**, púlsalo antes ([ci-cd.md](ci-cd.md#release-pull-requests)). El workflow
   **Release** crea el tag `v<versión>` y la GitHub release.
2. Despliega ese tag en staging y después en producción:

   ```
   gh workflow run deploy.yml --ref main -f environment=staging -f ref=v<versión>
   gh run watch
   gh workflow run deploy.yml --ref main -f environment=production -f ref=v<versión>
   ```

3. La ejecución de producción se detiene en **Release to production (server)** esperando la
   aprobación: un revisor abre la ejecución en GitHub → **Review deployments** → **Approve and
   deploy**.

**Comprueba:** las dos ejecuciones terminan en verde; producción no construye nada (su resumen lista
los tres digests de la ejecución de staging, "built and scanned by run <su id>");
https://app.acme.com abre la página de inicio de sesión.

### 8.4 Crea el primer administrador

En cada servidor (staging y producción), como `deploy`:

```
cd /srv/app
read -rs PASSWORD
```

Escribe la contraseña (12 caracteres o más; no se muestra nada), pulsa Enter y después:

```
printf '%s' "$PASSWORD" | docker compose --env-file server.env --env-file release.env \
  run --rm -T api node dist/users/create-user.cli.js \
  --email <email del primer administrador> --name "<Nombre>" --role admin
unset PASSWORD
```

**Comprueba:** imprime `Created the admin account <email> (<id>).`; inicia sesión en el sitio con
ese email y esa contraseña; las pantallas de administración están ahí.

Otras cuentas: el mismo comando con `--role member`, hasta que el producto tenga su propio registro
o sus invitaciones (fase 6).

### 8.5 Ensaya un rollback (staging)

Staging ejecuta `v<versión>` (8.3) y guarda el build de 8.1 como la release anterior: es lo que un
rollback vuelve a poner. En el servidor de staging:

```
cd /srv/app
./rollback.sh
```

**Comprueba:** imprime `rollback: running <commit de 8.1>`;
https://staging.acme.com/app-config.json muestra ese commit como `release`; el sitio sigue
funcionando.

Después devuelve staging a la release con el workflow, como cualquier despliegue:

```
gh workflow run deploy.yml --ref main -f environment=staging -f ref=v<versión>
gh run watch
```

**Comprueba:** la ejecución termina en verde y `app-config.json` vuelve a mostrar el commit de
`v<versión>`. Hacer un rollback (una vuelta atrás) ya es algo que has hecho, no algo que has leído.

---

## Fase 9. Monitorización y alertas

### 9.1 Informes de errores (Sentry)

1. En Sentry, crea dos proyectos: **Node.js** (la API) y **Browser JavaScript** (la app web).
   Copia el DSN de cada proyecto.
2. En cada servidor, añade `SENTRY_DSN=<DSN de la API>` a `api.env` y `WEB_SENTRY_DSN=<DSN de la web>`
   a `web.env`, y después:

   ```
   cd /srv/app
   docker compose --env-file server.env --env-file release.env up -d --wait api web
   ```

**Comprueba:** `https://app.acme.com/app-config.json` muestra el DSN de la web; la línea de log de
la API muestra `Starting release … error tracking on`
(`docker compose --env-file server.env --env-file release.env logs api | head`).
En Sentry, define las reglas de alerta: [alerting.md](alerting.md).

### 9.2 Uptime

En tu monitor de uptime, añade dos checks, cada minuto y desde varias regiones:

- `https://app.acme.com/healthz` (el servidor web),
- `https://app.acme.com/app-config.json` (se sirve la configuración de la app).

Envía las alertas a las personas de 0.1 (email y una notificación en el teléfono).

**Comprueba:** los dos checks muestran "up"; envía la notificación de prueba del monitor y confirma
que la recibió cada persona de la lista.

### 9.3 Logs

Los logs de los contenedores se quedan en el servidor (`docker compose … logs`), con rotación:
cinco ficheros de 10 MB por contenedor. Si tienes más de un
servidor, o para buscar en ellos, envíalos a un servicio de logs
([observability.md](observability.md)).

---

## Fase 10. Antes de los usuarios reales

Recorre [production-readiness.md](production-readiness.md) con el equipo y marca cada línea con su
evidencia. Las que esta guía todavía no ha cubierto:

1. **Un simulacro de restore** de la base de datos: restaura el último backup en una instancia nueva
   con la herramienta de tu proveedor y comprueba los datos
   ([disaster-recovery.md](disaster-recovery.md#checklist)). Apunta cuánto tardó.
2. **Alertas y SLOs** acordados ([alerting.md](alerting.md)).
3. **La tabla de contactos** de [incident-response.md](incident-response.md), rellena.
4. **Legal**: política de privacidad, términos, aviso de cookies, según exija tu mercado.
5. **La aprobación de producción** en GitHub tiene al menos un revisor que no es el autor.

**Comprueba:** el bloque de firma (Sign-off) al final de production-readiness.md está relleno.

---

## Fase 11. El ciclo diario

Cada cambio, de la misma forma:

| Paso                   | Haz                                                                                                                                           | Comprueba                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1. Empieza             | `git switch main && git pull && pnpm install && pnpm db:migrate && pnpm dev`                                                                  | la app corre en local                   |
| 2. Rama                | `git switch -c feat/<descripción-corta>` (o `fix/…`, `chore/…`)                                                                               | `git branch` la muestra                 |
| 3. Cambia              | código y tests juntos ([how-to.md](how-to.md)); un cambio de esquema: `pnpm db:migrate --name <nombre>`; un cambio de la API: `pnpm contract` | la app hace lo que pide el issue        |
| 4. Verifica            | `pnpm verify` (y `pnpm test:integration` para cambios de la API, `pnpm test:e2e` para flujos de usuario)                                      | todo en verde                           |
| 5. Commit              | `git add -A && git commit -m "feat(<área>): <qué>"`                                                                                           | los hooks pasan                         |
| 6. Push y pull request | `git push -u origin HEAD && gh pr create --fill`                                                                                              | **CI passed** en verde                  |
| 7. Revisión            | un compañero revisa; responde a cada comentario                                                                                               | aprobado                                |
| 8. Merge               | **Squash and merge**                                                                                                                          | el pull request de release se actualiza |
| 9. Release             | mergea el pull request de release cuando quieras una versión                                                                                  | un tag `vX.Y.Z`                         |
| 10. Despliega          | Despliega el tag en staging, pruébalo, y después en producción (aprobación)                                                                   | smoke test en verde en los dos          |
| 11. Vigila             | Sentry y el monitor de uptime durante la hora siguiente                                                                                       | ningún error nuevo                      |

Si producción se comporta mal después de un despliegue: `./rollback.sh` en el servidor, y después
corrige hacia delante con un pull request nuevo ([deploy-vps.md](deploy-vps.md#roll-back)).

---

## Fase 12. El calendario de mantenimiento

| Cuándo                                   | Haz                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cada semana                              | Aprueba los pull requests de actualización de Dependabot: los patch y minor se mergean solos cuando el CI está en verde; las majors y las de workflows las mergeas a mano.                                                                   |
| Cada semana                              | Lee los resultados del DAST (el workflow **DAST** se ejecuta los lunes).                                                                                                                                                                     |
| Cada mes                                 | En cada servidor: `docker image prune`, y `docker image rm` de las imágenes de release que no nombran `release.env` ni `release.previous.env` (docs/deploy-vps.md#keep-the-server-healthy); reinícialo si existe `/var/run/reboot-required`. |
| Cada trimestre                           | Un simulacro de restore de la base de datos; revisa las alertas; comprueba la caducidad de `RELEASE_PLEASE_TOKEN`, si lo configuraste.                                                                                                       |
| Cuando un secreto puede haberse filtrado | Rótalo de inmediato ([security.md](security.md#secret-rotation)).                                                                                                                                                                            |
| Después de cada incidente                | Un postmortem breve; actualiza el runbook y las alertas.                                                                                                                                                                                     |

---

## Cuando algo no está en esta guía

| Situación                                           | Dónde                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un mensaje de error                                 | [troubleshooting.md](troubleshooting.md) (busca unas palabras del mensaje)                                                                                                                                                                                                                         |
| Cómo funciona algo                                  | [manual.es.md](manual.es.md)                                                                                                                                                                                                                                                                       |
| Un tipo de cambio (tabla, endpoint, pantalla, rol…) | [how-to.md](how-to.md)                                                                                                                                                                                                                                                                             |
| El despliegue en el servidor, en detalle            | [deploy-vps.md](deploy-vps.md)                                                                                                                                                                                                                                                                     |
| Un incidente                                        | [incident-response.md](incident-response.md)                                                                                                                                                                                                                                                       |
| Una app móvil para el mismo producto                | la guía paso a paso de la plantilla móvil (`docs/STEP_BY_STEP.md`), cuyo contrato de API espera endpoints de inicio de sesión y de renovación del token con el refresh token en el cuerpo de la petición (esta API usa una cookie HTTP-only para los navegadores): añádelos cuando conectes la app |
