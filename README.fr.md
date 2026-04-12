<p align="right">
  <a href="./README.md">简体中文</a> | <a href="./README.en.md">English</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.ja.md">日本語</a> | Français
</p>

# AIS

> Un outil en ligne de commande que vous pouvez installer avec une seule commande `npm`, et qui aide à protéger mots de passe, clés et chaînes de connexion pour les agents IA, tout en fonctionnant **entièrement en local**.

L’objectif de `AIS` est simple :

- vous pouvez continuer à confier un vrai travail à une IA
- l’IA doit voir le moins possible les vrais secrets
- les vrais secrets ne sont restaurés que sur votre propre machine, au moment exact où ils sont nécessaires
- le workflow doit quand même réussir normalement

<p align="center">
  <img src="./docs/images/readme-flow-fr.jpg" alt="Fonctionnement d’AIS : le vrai mot de passe est d’abord remplacé localement par un jeton, l’IA dans le cloud ne voit que ce jeton, puis le vrai mot de passe est restauré localement uniquement au moment nécessaire" width="100%" />
</p>

## Installation En Une Ligne

```bash
npm install -g @tokentestai/ais
```

Après installation, la commande à utiliser est `ais`.

État actuel :

- prise en charge native de `macOS` et `Linux`
- prise en charge de `Windows` encore en cours
- prise en charge native de `Claude Code`, `Codex` et `OpenClaw`

## Quel Problème Est Résolu ?

De plus en plus de personnes donnent à des agents IA des mots de passe de sites, des mots de passe serveur, des chaînes de connexion de base de données, des clés API et d’autres informations sensibles pour que l’agent puisse se connecter, déployer, remplir des formulaires ou lancer des commandes.

C’est pratique, et cela devient clairement une tendance de fond.

Mais le problème est évident :

- si vous donnez à l’IA le **vrai mot de passe en clair**, cette donnée peut entrer dans un chemin visible par l’IA
- dès que le vrai mot de passe quitte votre machine, il devient beaucoup plus difficile de contrôler quels journaux, systèmes de support, couches de stockage ou services en aval peuvent y avoir accès
- que vous utilisiez des API officielles ou des fournisseurs d’API tiers, ces acteurs peuvent techniquement se trouver dans une position leur permettant d’observer le contenu des requêtes

`AIS` essaie de résoudre une chose :

**éviter que le vrai mot de passe quitte votre machine sans nécessité.**

## La Façon La Plus Simple De Le Comprendre

Supposons que vous demandiez à une IA de se connecter à un site pour vous, et que le vrai mot de passe soit :

```text
qwert123
```

`AIS` le remplace d’abord localement par un jeton de substitution comme :

```text
__SECRET_01__
```

À partir de là :

- l’IA voit `__SECRET_01__`
- le fournisseur de service IA voit aussi `__SECRET_01__`
- le vrai `qwert123` n’est pas envoyé directement

Ensuite, lorsque l’IA doit réellement exécuter l’action de connexion sur votre machine, `AIS` restaure localement :

```text
__SECRET_01__ -> qwert123
```

Ainsi, le site reçoit toujours le bon mot de passe réel `qwert123`, et la tâche ne rate pas simplement parce qu’une couche de protection a été ajoutée.

## Comment Ça Marche

Le processus complet peut se résumer en 5 étapes :

1. Vous donnez à l’IA un vrai mot de passe, une clé ou une chaîne de connexion pour qu’elle accomplisse une tâche.
2. `AIS` détecte localement cette donnée sensible et la remplace par un jeton.
3. Lorsque les données partent vers le cloud, l’IA ne voit que le jeton, pas la vraie valeur.
4. Quand l’IA exécute réellement une commande locale, remplit un formulaire ou écrit une configuration sur votre machine, `AIS` restaure localement la vraie valeur.
5. La tâche se termine normalement, mais le vrai secret essaie de ne pas quitter votre machine.

En version très simple :

- on masque localement avant l’envoi
- on restaure localement seulement au moment utile

## Pourquoi Nous L’avons Créé

Nous sommes nous-mêmes de gros utilisateurs de `Claude Code`, `Codex` et `OpenClaw`.

Nous pensons que les utilisateurs vont continuer à donner plus de permissions aux agents IA, pas moins.

La vraie question n’est pas de savoir si l’IA doit aider à faire le travail.

La vraie question est :

**peut-on confier davantage à l’IA sans laisser les vrais mots de passe circuler en clair ?**

C’est exactement pour cela que `AIS` existe :

- local-first
- open source
- friction minimale
- focalisé sur une couche concrète de réduction du risque

## Cas D’usage

- laisser une IA se connecter à des sites sans envoyer le vrai mot de passe du site en clair vers le cloud
- laisser une IA opérer des serveurs sans exposer le mot de passe serveur brut à des pipelines de modèles externes
- laisser une IA écrire des configs, appeler des API et lancer des scripts sans exposer directement clés et chaînes de connexion
- conserver le confort de l’automatisation tout en réduisant l’exposition inutile des secrets

## Démarrage Rapide

Créez d’abord la configuration locale :

```bash
ais config
```

Si vous voulez enregistrer un secret manuellement :

```bash
ais add github-token
ais add github-token ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Lancer `Claude Code` avec protection :

```bash
ais claude
```

Lancer `Codex` avec protection :

```bash
ais -- codex --sandbox danger-full-access
```

Lancer `OpenClaw` avec protection :

```bash
ais -- openclaw <les arguments que vous utilisez normalement>
```

## Interface Terminal

`AIS` inclut aussi une interface terminal qui permet de :

- voir quelles valeurs ont bien été protégées
- marquer certaines valeurs comme “ne pas protéger”
- inspecter et ajuster le comportement local

Ouvrir l’interface :

```bash
ais ais
```

Par exemple :

```bash
ais ais exclude <id>
ais ais exclude-type PASSWORD
```

## Pourquoi Le “Tout En Local” Est Important

Le point n’est pas d’afficher les secrets d’une manière plus élégante.

Le vrai point est le suivant :

**les vrais mots de passe doivent rester sur votre machine autant que possible.**

Si le vrai mot de passe continue à sortir de votre machine, vous perdez le contrôle direct de ce qui peut arriver ensuite.

`AIS` essaie donc de garder les étapes critiques en local :

- détection locale
- remplacement local
- restauration locale
- exécution locale

## Limites Actuelles

Nous ne présentons pas cet outil comme une solution magique.

Il est utile, mais il ne résout pas tout.

Quelques limites importantes :

- si votre machine locale est déjà compromise, cet outil ne suffira pas
- ce n’est pas un système de permissions, et il ne remplace pas le moindre privilège, l’audit ou l’isolation
- si un jeton est découpé, transformé ou réécrit, la restauration peut échouer dans certains cas
- si une chaîne d’outils contourne complètement les couches visibles localement, la protection peut être limitée

La bonne formulation est donc :

`AIS` aide à **réduire la probabilité que les vrais secrets quittent votre machine**, mais cela ne veut pas dire “tout est désormais parfaitement sûr”.

## À Qui S’adresse-t-il ?

- aux personnes qui utilisent déjà des agents IA pour des tâches réelles
- aux personnes qui veulent donner plus d’autonomie à l’IA sans laisser circuler des mots de passe en clair
- aux personnes qui utilisent des API officielles ou des fournisseurs d’API tiers et veulent ajouter une couche locale de contrôle
- aux personnes qui veulent plus d’automatisation sans trop sacrifier l’ergonomie

## Validation Locale

Si vous voulez valider la version actuelle en local :

```bash
npm install
npm run lint
npm run build
npm run test
npm run typecheck
```

## Open Source

Il s’agit d’un outil open source, pensé d’abord pour le local.

Il ne cherche pas à remplacer toute votre stratégie de sécurité.

Il cherche à corriger une faiblesse très courante et très concrète dans les workflows IA modernes :

**si vous devez donner un mot de passe à une IA, ne commencez pas par envoyer le vrai mot de passe en clair.**

## Licence

MIT
