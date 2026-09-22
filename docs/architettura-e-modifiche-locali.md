# EPOS Agent: architettura locale, caricamento delle skill e modifiche in corso

Questo documento descrive lo stato effettivo del repository locale al 16 settembre
2026. Serve come guida tecnica del progetto e come fotografia del worktree prima
di un commit.

> Nota sull'attribuzione delle modifiche: Git mostra quali file sono diversi da
> `HEAD`, ma non quando o da chi sia stata fatta ogni singola modifica non
> committata. Per questo il capitolo “Modifiche locali” distingue le modifiche
> introdotte nell'intervento sulla ricerca EPOS da quelle che erano già presenti
> nel worktree e che costituiscono l'architettura attuale.

## 1. Obiettivo del progetto

EPOS Agent è un'interfaccia conversazionale per trovare, descrivere, scaricare e
analizzare dati della European Plate Observing System (EPOS). Non è un unico
script che chiama un modello: è una composizione di quattro livelli con compiti
separati.

```text
Ricercatore
    │ richiesta in linguaggio naturale
    ▼
Pi Coding Agent
    │ modello, sessione, prompt, skill, strumenti attivi
    ▼
Estensione epos-tools
    │ router, stato conversazionale, sicurezza, provenance, telemetria
    ├─────────────────────────────────────┐
    ▼                                     ▼
MCP EPOS locale                       MCP FDSN locale
catalogo e servizi EPOS               eventi sismici e dettagli evento
    │                                     │
    ▼                                     ▼
API EPOS pubblica                     datacenter FDSN
    │
    ▼
workspace/, logs/provenance/, sessions/
```

La separazione è intenzionale:

- Pi è il runtime dell'agente e parla con il provider/modello scelto.
- Le skill spiegano al modello *quando* e *come* usare le capacità.
- L'estensione Pi controlla quali tool sono visibili e traduce le chiamate
  dell'agente nei due server MCP.
- I server MCP implementano operazioni deterministiche sui servizi esterni e
  ritornano contratti strutturati, non istruzioni per il modello.

Questo evita di incorporare nel prompt sia l'intero OpenAPI sia tool non
pertinenti alla domanda corrente.

## 2. Mappa dei file importanti

| Percorso | Responsabilità |
| --- | --- |
| `bin/epos-agent` | Launcher: carica configurazione, prompt, skill ed estensione, poi avvia Pi. |
| `prompts/SYSTEM.md` | Regole globali corte: tool minimi, selezione esplicita, sicurezza download e workspace. |
| `extensions/epos-tools/index.ts` | Integrazione Pi: router dei tool, client MCP stdio, FDSN, stato, provenance e telemetria. |
| `services/mcp-epos/tools/epos_mcp_http.py` | Server MCP Python per catalogo, organizzazioni, metadata e download EPOS. |
| `services/mcp-epos/tools/epos_mcp_stdio.py` | Entry point stdio usato localmente da EPOS Agent. |
| `services/mcp-epos/definitions/api-spec.json` | Copia locale del contratto OpenAPI EPOS, autorevole per chi mantiene l'MCP ma non caricata nel prompt. |
| `services/mcp-fdsnws-event/` | Server FDSN specialistico già separato dal catalogo EPOS. |
| `skills/epos-search/SKILL.md` | Istruzioni progressive per la discovery di catalogo, provider e software. |
| `skills/epos-service-access/SKILL.md` | Istruzioni per descrizione, parametri, preventivo e download di un elemento già scelto. |
| `skills/epos-fdsn-earthquakes/SKILL.md` | Istruzioni per gli eventi sismici FDSN. |
| `docs/status.md` | Stato funzionale, verifiche già eseguite e backlog. |
| `install.sh` | Installa una copia del progetto in `~/epos-agent`, dipendenze Pi/Node/Python e i server MCP. |
| `workspace/` | Dati completi, script e immagini prodotti durante le sessioni; non è contesto del modello. |
| `logs/provenance/` | Un file JSON per operazione con fonte, parametri e timestamp. |
| `logs/token-usage.jsonl` | Metriche per messaggio del modello, senza prompt o dataset completi. |

## 3. Avvio dell'agente

Il punto di ingresso è `bin/epos-agent`. Determina `ROOT` da
`EPOS_AGENT_ROOT` oppure, per default, da `~/epos-agent`; legge
`config/profile.env` se esiste; poi avvia Pi.

Il launcher passa esplicitamente:

```text
--no-extensions --no-skills --no-prompt-templates --no-context-files
--system-prompt prompts/SYSTEM.md
--skill skills/
--extension extensions/epos-tools/index.ts
--tools <lista controllata>
```

Le opzioni `--no-*` disabilitano materiale scoperto automaticamente da Pi. Il
progetto registra quindi solo prompt, skill ed estensione presenti nel proprio
repository. Questo è importante sia per riproducibilità sia per evitare che una
skill personale installata altrove cambi il comportamento scientifico.

Provider, modello e livello di reasoning non hanno più un default OpenAI o
GPT fissato dal launcher. Possono arrivare da Pi oppure dalle variabili
`EPOS_PROVIDER`, `EPOS_MODEL` ed `EPOS_THINKING` (con le equivalenti Pi come
fallback). Il requisito reale è il supporto al tool calling: un modello solo
testuale non può invocare catalogo, FDSN o download.

`--setup-gemini` è un percorso interattivo separato: salva una chiave Gemini e
il provider in `config/profile.env` con permessi ristretti. Il file di esempio
non contiene segreti e documenta solo le variabili opzionali.

```text
La skill originale ricevuta con il progetto citava strumenti come
`tools/epos.py` e un harness LM Studio. Quei file e quel runtime non fanno parte
di questa codebase: erano riferimenti del progetto di provenienza della skill.
Le sue regole utili sono state adattate ai tool Pi/MCP realmente disponibili;
non si tenta di invocare quei tool inesistenti.

### 4.1 Caricamento progressivo e costo in token

Il launcher ora passa l'intera directory `skills/` a Pi. All'avvio Pi scopre i
tre `SKILL.md`, ma nel contesto iniziale espone soltanto nome, descrizione e
percorso; non include i corpi completi delle skill. La verifica nativa del loader
Pi ha rilevato esattamente queste tre skill, senza diagnostiche, con un blocco di
descrizioni di 1.497 caratteri e senza i body.

Quando la richiesta lo richiede, il modello usa `read` per aprire il solo
`SKILL.md` pertinente. A quel punto le istruzioni complete diventano contesto
del turno. In pratica:

| Richiesta | Skill da leggere | Capability da caricare |
| --- | --- | --- |
| “Trova cataloghi terremoti” | `epos-search` | `catalog_search` |
| “Cerca il software X” | `epos-search` | `software_search` |
| “Spiegami questa risorsa / scaricala” | `epos-service-access` | `description`, poi `download` se necessario |
| “Eventi M≥4 in Italia” | `epos-fdsn-earthquakes` | `seismology` |
| “Analizza il file che ho scaricato” | Nessuna skill aggiuntiva obbligatoria | `analysis` |

Questo è un caricamento progressivo dei tool. Il processo `mcp-epos` viene
inizializzato insieme alla sessione per evitare race condition e conservare gli
ID temporanei; il server specialistico FDSN parte invece alla prima chiamata.

### 4.2 Le tre skill

**`epos-search`** stabilisce il comportamento di discovery. Impone query
catalografiche inglesi, brevi e precise, preservando nomi propri, date, bounding
box e filtri confermati. Se il provider è nominato, la prima operazione deve
essere la risoluzione dell'organizzazione. L'estensione attraversa internamente
tutte le pagine e presenta soltanto i titoli utili raggruppati per funzione
scientifica. Dopo un risultato vuoto è consentito un solo tentativo più ampio.

**`epos-service-access`** entra in gioco solo dopo la selezione. Chiede di
ispezionare metadata e parametri normalizzati prima dell'esecuzione, di non
inventare parametri e di dichiarare separatamente stime e valori certi. Il piano
complessivo richiede una sola conferma e dispone di un budget cumulativo di
1 GiB per studio.

**`epos-fdsn-earthquakes`** è isolata perché la ricerca eventi non è una ricerca
nel catalogo EPOS. Stabilisce filtri FDSN, datacenter e identità opaca degli
event ID. Senza un `limit` richiesto dall'utente, l'adapter segue tutte le pagine
e salva il dataset JSONL completo; un file `.partial.jsonl` non deve essere
presentato come completo.

### 4.3 La directory `skills/epos/` vuota

La vecchia skill monolitica era `skills/epos/SKILL.md`. Il file è stato rimosso
in favore delle tre skill. La directory può restare fisicamente vuota sul disco,
ma Git non traccia directory vuote e Pi non la considera una skill perché non
contiene `SKILL.md`. È innocua; può essere cancellata localmente oppure lasciata
finché non viene fatto un cleanup esplicito.

## 5. Router dei tool e visibilità per turno

Il router vive in `extensions/epos-tools/index.ts`. Il suo scopo è ridurre sia i
token degli schemi tool sia la probabilità di selezionare una capacità fuori
contesto.

All'inizio di ogni turno sono attivi soltanto:

```text
read
epos_load_tools
```

Il modello deve chiamare autonomamente `epos_load_tools`; non deve chiederlo al
ricercatore. Il router abilita quindi **un gruppo** e conserva solo `read`, il
router stesso e gli strumenti del gruppo richiesto. Al turno utente successivo,
il hook `before_agent_start` richiama `resetTools` e torna al set minimo.

| Gruppo | Tool Pi attivati | Uso |
| --- | --- | --- |
| `catalog_search` | `epos_mcp_call` | Provider e risorse/distribuzioni tramite la fonte primaria EPOS. |
| `description` | `epos_mcp_call` | Metadata di una distribuzione scelta. |
| `download` | `epos_mcp_call` | Preparazione ed esecuzione tramite MCP EPOS. |
| `seismology` | `epos_fdsnws_event_call` | Eventi e dettagli FDSN. |
| `analysis` | `read`, `epos_run_python`, `epos_show_image` | Elaborazione/immagini nel workspace. |
| `workspace` | `read`, `write`, `edit`, `ls`, `find`, `grep` | Gestione esplicita dei file di lavoro. |

Il profilo stdio completo espone undici tool, inclusi ricerca e paginazione,
organizzazioni, dettagli, preparazione/esecuzione, ispezione e fetch controllato.

L'estensione espone wrapper con prefisso `epos_` perché Pi non parla
direttamente con il server: il wrapper avvia il processo stdio, gli invia
`tools/call`, aggiunge provenance, limita il materiale reinserito nella chat e
aggiorna lo stato conversazionale. Il tool FDSN è invece un wrapper unico che
smista le sei operazioni supportate dal suo MCP.

## 6. Ciclo di vita dei server MCP

`StdioMcpClient` incapsula un processo figlio JSON-RPC su stdin/stdout. Ci sono
due istanze:

- EPOS: `services/mcp-epos/.venv/bin/python services/mcp-epos/tools/epos_mcp_stdio.py`;
- FDSN: il binario del virtual environment in
  `services/mcp-fdsnws-event/.venv/bin/`.

L'hook `session_start` avvia e inizializza MCP EPOS prima che l'agente accetti
richieste. La stessa istanza viene riusata per l'intera sessione; FDSN resta
lazy. Durante l'inizializzazione viene negoziata la versione MCP `2025-11-25`.
Gli errori del processo liberano le richieste pendenti invece di lasciare
promesse sospese.

Questa scelta riduce tempo e consumo per conversazioni che terminano prima di
un accesso dati e consente di lanciare EPOS Agent anche se una capability non
usata non è ancora inizializzabile.

## 7. Come funziona la ricerca nel catalogo EPOS

### 7.1 Percorso generale

1. Il modello legge `epos-search` e carica `catalog_search`.
2. Converte la domanda in una query inglese concisa, senza alterare nomi propri
   o filtri scientifici già confermati.
3. Se l'utente ha citato un provider, chiama prima `epos_search_organizations`.
4. Se la risoluzione è univoca, passa l'ID selezionato, invariato, a
   `epos_search_resources`; se è ambigua, mostra candidati e attende una scelta.
5. Mostra tutte le cinque (o meno) schede della pagina, con titolo, provider,
   ID e motivazione di rilevanza basata su metadata.
6. Attende prima di richiedere `nextOffset`. Non descrive né esegue
   automaticamente un risultato, salvo richiesta esplicita di selezione automatica.

Questo è il “ragionamento” prescritto all'agente: non un algoritmo nascosto che
sceglie dati al posto dell'utente, ma una sequenza di decisioni verificabili e
researcher-in-the-loop.

### 7.2 `search_organizations`: risoluzione dei provider

Il tool riceve `q` obbligatorio, `country` facoltativo, `offset` e `limit`; il
limite è validato fra 1 e 5. Richiede il solo endpoint pubblico
`/resources/organizations`, senza usare il costoso endpoint
`/resources/organizations/full`.

Poiché la ricerca remota delle organizzazioni può restituire più record di
quanti la query faccia pensare, il server applica localmente:

- confronto normalizzato (minuscole, accenti rimossi, punteggiatura uniformata);
- filtro per nome e, se presente, paese;
- deduplicazione per ID;
- ranking per nome esatto, prefisso, parola intera, contenimento e URL;
- paginazione solo dopo filtro, deduplicazione e ordinamento.

Il risultato è compatto: ID, nome, paese, URL, paginazione e provenance. La
provenance contiene endpoint, tempo di recupero, HTTP status, content type e
byte della risposta sorgente.

### 7.3 `search_resources`: flattening, filtri e ranking

L'API EPOS restituisce una struttura gerarchica. `collectDistributions` la
percorre ricorsivamente e trasforma le `distributions` in candidati piatti.
Durante il flattening conserva il percorso dei domini catalografici in un campo
interno `_catalogDomains`; senza questo passaggio il dominio del nodo padre
andava perso e i filtri/ranking successivi non potevano usarlo.

La pipeline locale è:

```text
albero EPOS
  → distributions piatte + dominio ereditato
  → deduplica per id
  → filtro locale scienceDomains (nome o codice)
  → ranking lessicale locale
  → offset/limit (massimo 5)
  → schede compatte
```

Il filtro `scienceDomains` non viene più affidato al parametro remoto
`sciencedomains`, il cui comportamento era inaffidabile nella verifica. Il tool
lo dichiara esplicitamente in `appliedLocally` e restituisce anche
`totalBeforeLocalFilters`, così l'agente può distinguere il totale grezzo da
quello mostrabile.

Il ranking locale, stabile a parità, compara nell'ordine:

1. titolo uguale alla query normalizzata;
2. frase completa nel titolo;
3. numero di token della query presenti nel titolo;
4. frase in provider o dominio;
5. token in provider o dominio;
6. frase nella descrizione;
7. token nella descrizione.

Se due elementi hanno lo stesso vettore di ranking, resta l'ordine originario
EPOS. Il ranking precede la paginazione: una risorsa molto pertinente non viene
quindi esclusa soltanto perché era più in basso nel grande albero remoto.

Ogni scheda restituisce ID, titolo, provider, domini, formati, riassunto
troncato a 240 caratteri e `status` solo se presente. Facet e payload raw non
passano nel risultato destinato al modello.

Il test live con “earthquake catalogue” ha restituito otto candidati filtrati,
cinque nella prima pagina, con cataloghi ESHM20 nelle prime posizioni. Il test
“INGV” ha messo al primo posto l'organizzazione ufficiale e la ricerca successiva
con il suo ID ha restituito soltanto provider INGV nelle schede mostrate.

### 7.4 Ricerca software

`search_software` è separato in un gruppo differente per non caricare il suo
schema durante una normale ricerca dati. Applica paginazione compatta analoga e
restituisce una scheda software con provider, domini, formati e sintesi. La
skill di search dice di caricarlo solo per software.

## 8. Metadata, servizi e download EPOS

Una ricerca restituisce un candidato; non equivale a dati scaricati. Dopo la
scelta del ricercatore l'agente può usare:

- `describe_resource` per metadata compatti della distribuzione;
- `describe_software` per un record software;
- `describe_service` per endpoint, documentazione, formati e parametri
  normalizzati;
- `execute_service` per eseguire una risorsa read-only.

`execute_service` recupera prima i dettagli della risorsa, valida i parametri
contro quelli dichiarati dal servizio e costruisce la richiesta gateway.

- il piano complessivo richiede una sola conferma prima delle chiamate che
  acquisiscono dati scientifici e non include stime di dimensione;
- ricerca, metadata, descrizioni e capabilities restano automatici;
- ogni studio ha un limite cumulativo di 1 GiB;
- il limite è controllato durante il trasferimento;
- l'intera risposta viene scritta in `workspace/`, mentre la chat riceve solo
  percorso, valori misurati, tipo, stato, metadata essenziali, al massimo cinque
  record rappresentativi e provenance;
- un errore nello streaming conserva il file con suffisso `.partial` e ne
  dichiara esplicitamente la completezza non verificata o parziale.

Il nome di default è derivato da ID risorsa, timestamp ed estensione coerente
con content type/formato. Un `outputFileName` esplicito deve essere un semplice
filename, quindi non può uscire dal workspace mediante `../`.

## 9. FDSN: eventi sismici separati dal catalogo

`epos_fdsnws_event_call` accetta un'operazione FDSN e il relativo dizionario di
argomenti. Prima normalizza alcuni alias (`minmagnitude` → `minmag`, ecc.) e
rifiuta parametri non supportati o alias in conflitto.

Per `fdsn_query_earthquakes`:

1. se l'utente ha dato `limit`, invia esattamente quella richiesta;
2. senza `limit`, divide adattivamente l'intervallo temporale quando una
   risposta raggiunge il limite del provider;
3. converte righe/colonne del server in JSONL e deduplica per datacenter ed
   `EventID`;
4. conserva soltanto cinque esempi per la chat;
5. registra contatore, numero pagine, byte, datacenter, endpoint e filtri;
6. rispetta il budget residuo del limite cumulativo di 1 GiB dello studio;
7. dopo un errore con record già acquisiti rinomina il file in `.partial.jsonl`,
   registra `complete: false` e segnala un errore strutturato.

Per le operazioni di dettaglio, se la risposta supera il limite chat viene
salvata in un JSON nel workspace. L'identificatore di evento viene trattato come
opaco e legato al datacenter: non deve essere modificato né riusato altrove.

## 10. Stato conversazionale, provenance e limiti di contesto

L'estensione mantiene un piccolo `ConversationState` con:

- intento e dominio;
- filtri confermati;
- ID della risorsa selezionata e formato;
- fino a dieci file recenti e fino a dieci file di provenance;
- timestamp di aggiornamento.

Lo stato è salvato come voce custom nel branch della sessione Pi. All'avvio o al
cambio branch viene ripristinato; prima del turno viene reinserito nel prompt
come un breve blocco XML. Non conserva risposte raw, interi cataloghi o dataset:
serve a riutilizzare informazioni già confermate senza ripetere domande.

Ogni wrapper scrive una provenance JSON in `logs/provenance/`. Per le chiamate
EPOS include tipicamente azione, parametri, endpoint, timestamp, HTTP status,
content type e byte sorgente. Python e FDSN aggiungono i rispettivi dettagli
operativi. Il risultato chat include il path della provenance.

`modelResult` limita a 12.000 caratteri la serializzazione reiniettata nel
modello. Se un risultato è più grande, il modello riceve una preview marcata
`truncatedInChat`; l'oggetto completo resta nei `details` del tool o in un file
del workspace. È una protezione del contesto, non una perdita silenziosa di
dati scaricati.

L'hook `message_end` registra in `logs/token-usage.jsonl` uso input/output,
cache, reasoning, provider, modello e tool attivi. Non registra prompt né dati
scientifici completi.

## 11. Sicurezza del filesystem e delle operazioni

Le operazioni di scrittura dell'estensione controllano che i path risolti restino
dentro `workspace/`. Questo vale per script Python esistenti, immagini da
mostrare e output indicati dall'utente. Python viene avviato con working
directory nel workspace, timeout limitato a 300 secondi e buffer massimo di
10 MB. L'estensione non trasforma il workspace in un accesso generico alla home.

L'accesso ai servizi pubblici EPOS/FDSN è “open world” dal punto di vista MCP,
mentre le operazioni catalografiche e descrittive sono annotate read-only. Il
download cambia il filesystem locale e perciò ha una policy più prudente.

## 12. OpenAPI: dove si trova e come va usato

Il file `services/mcp-epos/definitions/api-spec.json` è una copia locale
dell'OpenAPI fornito per l'API EPOS. Non viene passato con `--skill`, non viene
letto nel prompt di sistema e non serve all'agente per ogni query. È il contratto
di riferimento per chi modifica `server.mjs`: endpoint, campi e tipi vanno
confrontati lì prima di estendere l'MCP.

Questo è diverso dalla skill: l'OpenAPI definisce l'interfaccia tecnica del
server; la skill definisce il workflow conversazionale. Caricare circa 594 KB di
specifica a ogni richiesta sarebbe uno spreco e aumenterebbe il rischio che il
modello ragioni su dettagli non pertinenti.

## 13. Modifiche locali non committate

Al momento della stesura il worktree contiene modifiche a:

```text
README.md
bin/epos-agent
config/profile.env.example
docs/architecture-v0.2.md
extensions/epos-tools/index.ts
prompts/SYSTEM.md
services/mcp-epos/requirements.txt
services/mcp-epos/tools/epos_mcp_http.py
services/mcp-epos/tools/epos_mcp_stdio.py
skills/epos/SKILL.md                  (eliminato)
docs/status.md                        (nuovo)
services/mcp-epos/definitions/        (nuova)
skills/epos-fdsn-earthquakes/         (nuova)
skills/epos-search/                   (nuova)
skills/epos-service-access/           (nuova)
```

### 13.1 Intervento specifico sulla search EPOS

Queste sono le modifiche introdotte per il piano “EPOS search precisa con skill
progressive”:

| Area | Cambiamento |
| --- | --- |
| Skill | Rimossa la skill monolitica e aggiunte le tre skill progressive. |
| Launcher | Da `--skill skills/epos` a `--skill skills`, così Pi scopre tutte e tre le skill. |
| Prompt | Aggiunta la regola di caricare e seguire la skill EPOS pertinente. |
| Router | Aggiunto `epos_search_organizations` al gruppo `catalog_search` e alla lista del launcher. |
| MCP EPOS | Aggiunto `search_organizations` con input/output compatti, filtro/ranking/deduplica locali e massimo cinque risultati. |
| MCP EPOS | Corretto `search_resources`: dominio preservato nel flattening, deduplica per ID, filtro locale `scienceDomains`, ranking prima della paginazione, `status` facoltativo e indicazione dei filtri locali. |
| Contratto | Copiato l'OpenAPI fornito in `services/mcp-epos/definitions/api-spec.json`, fuori dal contesto dell'agente. |
| Stato | Aggiornato `docs/status.md` con architettura, risultati e backlog. |

Non è stato aggiunto alcun accesso a `/resources/organizations/full`; non sono
stati creati test, fixture o artefatti permanenti per questa modifica.

### 13.2 Altre evoluzioni locali che formano l'architettura attuale

Le altre differenze non committate mostrano l'evoluzione verso la versione
0.2.0: launcher provider-neutral, router a tool minimi, server MCP lazy,
contratti `structuredContent`, download in streaming, FDSN multipagina, stato
conversazionale, provenance e telemetria. Questa guida descrive il loro
funzionamento perché sono già parte del comportamento locale; Git da solo non
permette però di attribuirle tutte al singolo intervento sulla search.

`README.md` e `docs/architecture-v0.2.md` aggiornano la documentazione verso
questa architettura. `package.json` e lockfile portano il server MCP alla
versione 0.2.0 e aggiornano la dipendenza SDK MCP. Il file
`config/profile.env.example` elimina il default provider/modello e documenta le
variabili opzionali.

## 14. Verifiche essenziali già effettuate

Le verifiche fatte per l'intervento search sono intenzionalmente minime:

- parsing di `server.mjs` con `node --check`;
- parsing TypeScript dell'estensione con Node;
- controllo sintassi del launcher con `bash -n`;
- validazione JSON e confronto SHA-256 della copia OpenAPI con il file fornito;
- `git diff --check`;
- discovery nativa Pi: tre skill, nessuna diagnostica, descrizioni senza body;
- smoke test stdio MCP: protocollo `2025-11-25` e undici tool registrati con
  `structuredContent`;
- due query live: “earthquake catalogue” e risoluzione “INGV” seguita da ricerca
  tramite ID selezionato.

Il validatore opzionale della skill basato su Python non è stato usato con
successo perché nell'ambiente mancava il modulo `yaml`; questo non invalida la
discovery nativa Pi già passata, ma va ricordato se si vuole aggiungere quella
verifica in CI.

## 15. Cosa non è ancora implementato

Il progetto non deve essere descritto come completo oltre ciò che esiste. In
particolare, restano fuori dalla fase corrente:

- endpoint EPOS adiacenti per metadata più ricchi;
- fetch controllato di URL arbitrari;
- supporto operativo OGC, ispezione e visualizzazione specialistica;
- bundle riproducibile che raccolga automaticamente dataset, README, script e
  provenance;
- pre-analisi standardizzata (struttura, completezza, missing values, anomalie);
- template deterministici per grafici, mappe e notebook;
- modalità demo guidata;
- verifica end-to-end su più provider/modelli.

La dimensione della risposta grezza ricevuta dal server EPOS resta fuori scope:
l'MCP la deve comunque leggere per poter fare flattening e ranking; l'obiettivo
attuato è non trasferirla tutta al modello.

## 16. Come orientarsi durante la manutenzione

Per una modifica alla conversazione, iniziare da `prompts/SYSTEM.md` e dalla
skill più specifica. Per una modifica alla disponibilità dei tool, guardare
`TOOL_GROUPS` e `createLoadToolsTool` nell'estensione. Per cambiare endpoint,
schema o trasformazione EPOS, modificare `services/mcp-epos/tools/epos_mcp_http.py` e
confrontare l'OpenAPI locale. Per cambiare il ciclo di avvio o l'isolamento del
contesto, intervenire nel launcher.

Un'estensione nuova dovrebbe seguire questa regola pratica:

1. aggiungere il tool MCP solo se è una capacità tecnica riusabile;
2. aggiungere un wrapper Pi se occorrono router, provenance, stato o limiti
   di contesto;
3. assegnarlo a un gruppo `TOOL_GROUPS` il più stretto possibile;
4. aggiornare la skill soltanto se cambia la decisione che il modello deve fare;
5. tenere le risposte inviate al modello piccole e salvare i dati completi nel
   workspace;
6. verificare prima il contratto MCP e poi una query reale rappresentativa.

Questa disciplina mantiene separati i tre livelli fondamentali: *policy* nelle
skill, *orchestrazione* nell'estensione e *fatti/azioni tecniche* nei server MCP.
