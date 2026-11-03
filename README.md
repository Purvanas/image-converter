# Convertisseur multimédia

Une application web pour convertir des images, des vidéos, de l’audio, des PDF et des données JSON/CSV depuis une même interface.

**Démo : [convert.purvanas.fr](https://convert.purvanas.fr)**

Le projet est né d’un besoin quotidien : éviter de multiplier les services pour une conversion d’image, l’extraction d’une piste audio ou l’export d’un PDF. L’interface détecte le type de fichier, n’affiche que les formats pertinents et propose un aperçu lorsque le navigateur sait le rendre.

## Ce que le projet montre

- une interface sans framework, responsive et bilingue ;
- des traitements d’images avec Sharp ;
- des conversions audio et vidéo pilotées avec FFmpeg ;
- l’extraction des pages d’un PDF avec Poppler et la création de PDF avec pdf-lib ;
- la conversion JSON/CSV et la production d’archives ZIP ;
- une gestion explicite des limites multipart, conversions concurrentes, délais et fichiers temporaires.

Les fichiers sont écrits dans `uploads/`, puis supprimés après téléchargement ou par le nettoyage périodique. L’instance publique n’est pas un espace de stockage.

## Architecture

```text
public/index.html       interface et parcours de conversion
server.js               API, traitements et cycle de vie des fichiers
mediaTypes.js           détection des familles de médias
dataConverters.js       conversions JSON / CSV
previewMeta.js          métadonnées d’aperçu sûres
test/                    tests unitaires des fonctions pures
```

## Lancer le projet

Prérequis : Node.js 22+, FFmpeg et Poppler (`pdftoppm`). Sharp installe ses binaires lors de `npm ci` sur les plateformes prises en charge.

```bash
cp .env.example .env
npm ci
npm start
```

Les variables de `.env` ne sont pas chargées automatiquement : exporte-les avec ton gestionnaire de processus ou ton environnement d’exécution. Le serveur écoute par défaut sur `127.0.0.1:3400`, prévu pour être placé derrière un reverse proxy. `RUNTIME_DIR` permet de placer uploads, statistiques et journaux sur un volume séparé du code.

Le mode administrateur est facultatif. Il reste désactivé tant que `ADMIN_CODE` n’est pas défini. Il relève les plafonds de traitement pour l’instance personnelle ; il ne constitue pas un système de comptes.

## Limites de l’instance

Les limites publiques par défaut sont de 200 Mo pour les images et PDF, 50 Mo pour JSON/CSV, 300 Mo pour l’audio et 500 Mo pour la vidéo. Une conversion vidéo et deux conversions audio peuvent s’exécuter simultanément. Les valeurs sont adaptées à un petit serveur auto-hébergé.

Ce dépôt ne contient ni fichiers utilisateurs, ni statistiques, ni journaux d’erreurs, ni configuration de production. Les identifiants d’analytics ou de publicité de l’instance hébergée sont également hors du code public.

## Licence

Le code du projet est distribué sous licence MIT. Les dépendances conservent leurs licences respectives.
