import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { asApiError, postJson, type ApiError } from "../../api";
import { Modal } from "../../components/Dialog";
import { Field, NameField, type ControlProps } from "../../components/Form";
import { Icon } from "../../components/Icon";
import { Tabs } from "../../components/Layout";
import { Callout } from "../../components/Notice";
import { ToneBadge } from "../../components/Tone";
import { useNameDraft } from "../../me";
import { notify } from "../../notices";
import { rememberView } from "../../poll";
import type { InboxListView, UploadEmailResult } from "../../types";

// The upload dialog (ia.md section 5): an .eml file or its pasted source, sent as
// base64 inside JSON. The server opens the email in a worker before it answers,
// so the dialog shows the upload as queued while it waits, and as failed with the
// server's words when it is refused. A parsed upload opens as #inbox/N, which
// says whether all of it could be read.

type Source = "file" | "paste";

interface Failure {
  message: string;
  // A second upload of the same email: the upload already on file.
  uploadId: number | null;
}

const CHUNK: number = 0x8000;

function base64Of(bytes: Uint8Array): string {
  let binary: string = "";
  for (let at: number = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function failureOf(error: ApiError): Failure {
  const id: unknown = error.body?.["id"];
  return { message: error.message, uploadId: error.status === 409 && typeof id === "number" ? id : null };
}

// forInvoice: the payment the inbox was opened for (#inbox?for=ID).
export function UploadDialog(props: {
  forInvoice: string | null;
  limits: InboxListView["limits"] | null;
  onClose: () => void;
  onUploaded: (id: number) => void;
}): JSX.Element {
  const mounted = useRef<boolean>(true);
  const [source, setSource] = useState<Source>("file");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState<string>("");
  const [over, setOver] = useState<boolean>(false);
  const [name, setName] = useNameDraft();
  const [busy, setBusy] = useState<boolean>(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const maxBytes: number = props.limits?.maxEmailBytes ?? 2 * 1024 * 1024;

  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  function choose(chosen: File | null): void {
    setFile(chosen);
    setFailure(null);
  }

  async function upload(): Promise<void> {
    if (busy) {
      return;
    }
    setFailure(null);
    if (source === "file" && file !== null && file.size > maxBytes) {
      setFailure({ message: `The email is larger than ${megabytes(maxBytes)}. Paste its source without the attachment parts.`, uploadId: null });
      return;
    }
    setBusy(true);
    try {
      const bytes: Uint8Array =
        source === "file" ? (file === null ? new Uint8Array() : new Uint8Array(await file.arrayBuffer())) : new TextEncoder().encode(pasted);
      const result: UploadEmailResult = await postJson<UploadEmailResult>("/api/inbox", {
        uploadedBy: name,
        source,
        fileName: source === "file" ? (file?.name ?? null) : null,
        eml: base64Of(bytes),
      });
      rememberView(`/api/inbox/${result.id}`, result.view);
      notify(result.notice);
      props.onUploaded(result.id);
    } catch (caught: unknown) {
      if (mounted.current) {
        setFailure(failureOf(asApiError(caught)));
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }

  return (
    <Modal title={props.forInvoice === null ? "Upload email" : `Upload an email for ${props.forInvoice}`} busy={busy} onClose={props.onClose}>
      {props.forInvoice === null ? null : (
        <p class="muted">{`It lands in the inbox first. Deliver it to ${props.forInvoice} from there.`}</p>
      )}
      <Tabs
        label="Upload as"
        tabs={[
          { key: "file", label: "File" },
          { key: "paste", label: "Paste source" },
        ]}
        current={source}
        flush
        onSelect={(key: string): void => {
          setSource(key === "paste" ? "paste" : "file");
          setFailure(null);
        }}
      />
      {source === "file" ? (
        <label
          class={over ? "dropzone is-over" : "dropzone"}
          onDragOver={(event: DragEvent): void => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={(): void => setOver(false)}
          onDrop={(event: DragEvent): void => {
            event.preventDefault();
            setOver(false);
            choose(event.dataTransfer?.files[0] ?? null);
          }}
        >
          <input
            type="file"
            class="dropzone__input"
            accept=".eml,message/rfc822"
            autoFocus
            onChange={(event: Event): void => choose((event.currentTarget as HTMLInputElement).files?.[0] ?? null)}
          />
          <Icon name="mail" size={24} class="dropzone__icon" />
          <span class="dropzone__lead">Drop an .eml file here, or choose one</span>
          <span class="dropzone__hint">{`.eml up to ${megabytes(maxBytes)}`}</span>
          {file === null ? null : (
            <span class="dropzone__file">
              <bdi class="theirs">{file.name}</bdi>
              {` · ${sizeText(file.size)}`}
            </span>
          )}
        </label>
      ) : (
        <Field label="Email source">
          {(control: ControlProps): JSX.Element => (
            <textarea
              {...control}
              class="textarea mono upload-dialog__source"
              rows={8}
              spellcheck={false}
              placeholder="Paste the full source, headers included"
              value={pasted}
              onInput={(event: Event): void => setPasted((event.currentTarget as HTMLTextAreaElement).value)}
            />
          )}
        </Field>
      )}
      <NameField label="Uploaded by" value={name} onInput={setName} />
      {props.limits?.readerNotice === null || props.limits?.readerNotice === undefined ? null : (
        <Callout tone="warning">{props.limits.readerNotice}</Callout>
      )}
      {busy ? (
        <p class="upload-state" role="status">
          <ToneBadge tone="progress" label="Queued" />
          <span>PayOnce opens one email at a time and shows this one once it has read it.</span>
        </p>
      ) : failure === null ? null : (
        <div class="upload-state" role="alert">
          <ToneBadge tone="urgent" label="Failed" />
          <span>
            {failure.message}
            {failure.uploadId === null ? null : (
              <>
                {" "}
                <a href={`#inbox/${failure.uploadId}`} onClick={(): void => props.onClose()}>{`Open email ${failure.uploadId}`}</a>
              </>
            )}
          </span>
        </div>
      )}
      <div class="button-row">
        <button type="button" class="btn btn--primary" disabled={busy} aria-busy={busy} onClick={(): void => void upload()}>
          {busy ? "Uploading…" : "Upload"}
        </button>
        <button type="button" class="btn btn--secondary" disabled={busy} onClick={(): void => props.onClose()}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
