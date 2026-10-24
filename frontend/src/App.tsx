import type { User } from 'firebase/auth'
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import './App.css'

import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'firebase/auth'

import { auth, googleProvider } from './firebase'

// Override with VITE_API_URL when deploying the backend.
const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/$/, '')

type EmailStatus = 'Scheduled' | 'Processing' | 'Sent' | 'Failed'

type Attachment = {
  name: string
  type: string
  size: number
  data: string
}

type Email = {
  id: number
  email: string
  subject: string
  body: string
  scheduledAt: string
  status: EmailStatus
  delaySeconds?: number
  hourlyLimit?: number
  attachments?: Attachment[]
}

function GoogleLogo() {
  return (
    <svg
      className="google-logo"
      viewBox="0 0 48 48"
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
        transform="translate(0 5)"
      />

      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.72 7.18l7.64 5.93c4.46-4.12 7.12-10.2 7.12-17.58Z"
      />

      <path
        fill="#FBBC05"
        d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.2a23.96 23.96 0 0 0 0 21.58l7.98-6.2Z"
        transform="translate(0 5)"
      />

      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.9-5.87l-7.64-5.93c-2.12 1.42-4.83 2.26-8.26 2.26-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.2C6.51 42.62 14.62 48 24 48Z"
        transform="translate(0 -5)"
      />
    </svg>
  )
}

function Dashboard({ user }: { user: User }) {
  const [activeTab, setActiveTab] =
    useState<'scheduled' | 'sent'>('scheduled')

  const [emails, setEmails] = useState<Email[]>([])
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null)

  const [showCompose, setShowCompose] = useState(false)
  const [showProfile, setShowProfile] = useState(false)

  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [recipient, setRecipient] = useState('')
  const [recipients, setRecipients] = useState<string[]>([])
  const [leadFileName, setLeadFileName] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [delaySeconds, setDelaySeconds] = useState('2')
  const [hourlyLimit, setHourlyLimit] = useState('60')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isScheduling, setIsScheduling] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)

  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Email[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')

  
useEffect(() => {
  let isActive = true

  async function loadEmails() {
    try {
      // Firebase ID token authenticates this request with the backend.
      const token = await user.getIdToken()

      const response = await fetch(`${API_BASE_URL}/api/emails`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })

      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.error || 'Failed to load emails')
      }

      const data = await response.json()

      const savedEmails: Email[] = data.map(
        (item: {
          id: number
          recipient: string
          subject: string
          body: string
          scheduled_at: string
          status: string
        }) => ({
          id: item.id,
          email: item.recipient,
          subject: item.subject,
          body: item.body,
          scheduledAt: new Date(item.scheduled_at).toLocaleString(),
          status:
            item.status.toLowerCase() === 'scheduled'
              ? 'Scheduled'
              : item.status.toLowerCase() === 'sent'
                ? 'Sent'
                : item.status.toLowerCase() === 'processing'
                  ? 'Processing'
                  : 'Failed',
        }),
      )

      if (isActive) {
        setEmails(savedEmails)
        setNotice('')
      }
    } catch (error) {
      if (isActive) {
        console.error('Could not load emails:', error)

        setNotice(
          error instanceof Error
            ? error.message
            : 'Could not load emails. Check that the backend is running and you are signed in.',
        )
      }
    }
  }

  // Load immediately, then refresh every 5 seconds.
  void loadEmails()

  const refreshInterval = window.setInterval(() => {
    void loadEmails()
  }, 5000)

  return () => {
    isActive = false
    window.clearInterval(refreshInterval)
  }
}, [user])

  // Search through Elasticsearch on the backend; keep the local list as the
  // default view when the search box is empty.
  useEffect(() => {
    const query = search.trim()

    if (!query) {
      setSearchResults(null)
      setSearchLoading(false)
      setSearchError('')
      return
    }

    let isActive = true
    const controller = new AbortController()
    setSearchLoading(true)
    setSearchError('')

    const timeout = window.setTimeout(async () => {
      try {
        const token = await user.getIdToken()
        const response = await fetch(
          `${API_BASE_URL}/api/emails/search?q=${encodeURIComponent(query)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
        )

        if (!response.ok) {
          const result = await response.json().catch(() => ({}))
          throw new Error(result.error || 'Email search failed.')
        }

        const data = await response.json()
        const results: Email[] = data.map(
          (item: {
            id?: string | number
            emailId?: string | number
            recipient: string
            subject: string
            body?: string
            scheduledAt?: string
            sentAt?: string | null
            status: string
          }) => {
            const normalizedStatus = item.status.toLowerCase()
            const timestamp =
              normalizedStatus === 'sent' && item.sentAt
                ? item.sentAt
                : item.scheduledAt

            return {
              id: Number(item.emailId ?? item.id),
              email: item.recipient,
              subject: item.subject,
              body: item.body ?? '',
              scheduledAt: timestamp
                ? new Date(timestamp).toLocaleString()
                : '—',
              status:
                normalizedStatus === 'scheduled'
                  ? 'Scheduled'
                  : normalizedStatus === 'sent'
                    ? 'Sent'
                    : normalizedStatus === 'processing'
                      ? 'Processing'
                      : 'Failed',
            }
          },
        )

        if (isActive) setSearchResults(results)
      } catch (error) {
        if (isActive && !(error instanceof DOMException && error.name === 'AbortError')) {
          setSearchError(
            error instanceof Error ? error.message : 'Email search failed.',
          )
          setSearchResults([])
        }
      } finally {
        if (isActive) setSearchLoading(false)
      }
    }, 300)

    return () => {
      isActive = false
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [search, user])

  const visibleEmails = useMemo(() => {
    const sourceEmails = search.trim() ? (searchResults ?? []) : emails
    return sourceEmails.filter((email) =>
      activeTab === 'scheduled'
        ? email.status === 'Scheduled' || email.status === 'Processing'
        : email.status === 'Sent' || email.status === 'Failed',
    )
  }, [emails, activeTab, search, searchResults])

  function toLocalDateTimeInput(date: Date) {
    date.setSeconds(0, 0)
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16)
  }

  function getSuggestedScheduleTime() {
    // Start five minutes from now, rounded to a whole minute.
    return toLocalDateTimeInput(new Date(Date.now() + 5 * 60 * 1000))
  }

  function getMinimumScheduleTime() {
    // Allow at least one minute of lead time; do not make the minimum
    // five minutes ahead on every render, which would invalidate the default.
    return toLocalDateTimeInput(new Date(Date.now() + 60 * 1000))
  }

  function resetComposeForm() {
    setRecipient('')
    setRecipients([])
    setLeadFileName('')
    setSubject('')
    setBody('')
    setScheduledAt(getSuggestedScheduleTime())
    setDelaySeconds('2')
    setHourlyLimit('60')
    setAttachments([])
    setFormError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (attachmentInputRef.current) attachmentInputRef.current.value = ''
  }

  function openCompose() {
    setSelectedEmail(null)
    setShowProfile(false)
    setNotice('')
    setFormError('')
    setRecipient('')
    setRecipients([])
    setLeadFileName('')
    setSubject('')
    setBody('')
    setScheduledAt(getSuggestedScheduleTime())
    setDelaySeconds('2')
    setHourlyLimit('60')
    setAttachments([])
    setShowCompose(true)
  }

  function closeCompose() {
    setShowCompose(false)
    setFormError('')
  }

  function extractEmails(text: string) {
    const normalized = text.replace(/[;\n\r\t]+/g, ',')
    const matches = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []
    const valid = matches
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    return Array.from(new Set(valid))
  }

  async function handleLeadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!['csv', 'txt'].includes(extension ?? '')) {
      setFormError('Please upload a CSV or TXT lead file.')
      return
    }

    try {
      const text = await file.text()
      const detected = extractEmails(text)
      if (detected.length === 0) {
        setFormError('No valid email addresses were found in this file.')
        return
      }
      setRecipients(detected)
      setRecipient(detected.join(', '))
      setLeadFileName(file.name)
      setFormError('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch {
      setFormError('Could not read the lead file.')
    }
  }

  async function handleAttachmentFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) return

    const allowed = files.filter(
      (file) => file.type.startsWith('image/') || file.type === 'application/pdf',
    )

    if (allowed.length !== files.length) {
      setFormError('Only image files and PDF files can be attached.')
      return
    }

    const maxSize = 5 * 1024 * 1024
    if (allowed.some((file) => file.size > maxSize)) {
      setFormError('Each attachment must be 5 MB or smaller.')
      return
    }

    try {
      const converted = await Promise.all(
        allowed.map(
          (file) =>
            new Promise<Attachment>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () =>
                resolve({
                  name: file.name,
                  type: file.type,
                  size: file.size,
                  data: String(reader.result),
                })
              reader.onerror = () => reject(new Error('Could not read attachment'))
              reader.readAsDataURL(file)
            }),
        ),
      )

      setAttachments((current) => {
        const existingNames = new Set(current.map((item) => item.name))
        return [...current, ...converted.filter((item) => !existingNames.has(item.name))]
      })
      setFormError('')
    } catch {
      setFormError('Could not read one of the attachments.')
    }
  }

  function removeAttachment(name: string) {
    setAttachments((current) => current.filter((item) => item.name !== name))
  }

  async function handleSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError('')
    setNotice('')

    const cleanSubject = subject.trim()
    const cleanBody = body.trim()
    const parsedDelay = Number(delaySeconds)
    const parsedHourlyLimit = Number(hourlyLimit)
    const leadRecipients = recipients.length ? recipients : extractEmails(recipient)

    if (!leadRecipients.length || !cleanSubject || !cleanBody || !scheduledAt) {
      setFormError('Add at least one valid recipient, subject, body, and start time.')
      return
    }

    if (!Number.isInteger(parsedDelay) || parsedDelay < 1) {
      setFormError('Delay must be a whole number of at least 1 second.')
      return
    }

    if (!Number.isInteger(parsedHourlyLimit) || parsedHourlyLimit < 1) {
      setFormError('Hourly limit must be at least 1 email.')
      return
    }

    const scheduleDate = new Date(scheduledAt)
    if (Number.isNaN(scheduleDate.getTime()) || scheduleDate.getTime() <= Date.now()) {
      setFormError('Choose a start date and time in the future.')
      return
    }

    setIsScheduling(true)

    try {
      // Include the signed-in Firebase user's ID token when scheduling.
      const token = await user.getIdToken()
      const response = await fetch(`${API_BASE_URL}/api/emails`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          recipients: leadRecipients,
          subject: cleanSubject,
          body: cleanBody,
          scheduledAt: scheduleDate.toISOString(),
          delaySeconds: parsedDelay,
          hourlyLimit: parsedHourlyLimit,
          attachments,
        }),
      })

      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error || 'Could not schedule the campaign.')
      }

      const savedItems = Array.isArray(result) ? result : [result]
      const savedEmails: Email[] = savedItems.map((item) => ({
        id: item.id,
        email: item.recipient,
        subject: item.subject,
        body: item.body,
        scheduledAt: new Date(item.scheduledAt).toLocaleString(),
        status: item.status,
        delaySeconds: item.delaySeconds,
        hourlyLimit: item.hourlyLimit,
        attachments: item.attachments ?? attachments,
      }))

      setEmails((currentEmails) => [...savedEmails, ...currentEmails])
      setActiveTab('scheduled')
      setShowCompose(false)
      resetComposeForm()
      setNotice(`Campaign scheduled for ${savedEmails.length} recipient${savedEmails.length === 1 ? '' : 's'}.`)
    } catch (error) {
      console.error('Could not schedule campaign:', error)
      setFormError(
        error instanceof Error ? error.message : 'Could not connect to the backend. Please try again.',
      )
    } finally {
      setIsScheduling(false)
    }
  }

  const profileInitials = (
    user.displayName ||
    user.email ||
    'U'
  )
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

  if (selectedEmail) {
    return (
      <div className="app-shell">
        <aside className="sidebar">
          <Sidebar
            user={user}
            profileInitials={profileInitials}
            showProfile={showProfile}
            setShowProfile={setShowProfile}
            openCompose={openCompose}
          />
        </aside>

        <main className="main-content">
          <div className="detail-page">
            <button
              className="back-button"
              type="button"
              onClick={() => setSelectedEmail(null)}
            >
              ← Back
            </button>

            <div className="detail-header">
              <div>
                <p className="eyebrow">EMAIL</p>
                <h1>{selectedEmail.subject}</h1>
              </div>

              <span className="detail-status">
                {selectedEmail.status}
              </span>
            </div>

            <section className="email-detail-card">
              <div className="email-detail-meta">
                <div className="detail-avatar">
                  {selectedEmail.email
                    .charAt(0)
                    .toUpperCase()}
                </div>

                <div>
                  <strong>{selectedEmail.email}</strong>
                  <span>
                    Scheduled for {selectedEmail.scheduledAt}
                  </span>
                </div>
              </div>

              <div className="email-detail-body">
                {selectedEmail.body}
              </div>
            </section>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Sidebar
          user={user}
          profileInitials={profileInitials}
          showProfile={showProfile}
          setShowProfile={setShowProfile}
          openCompose={openCompose}
        />
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h1>Email dashboard</h1>
          </div>

          <button
            className="primary-button"
            type="button"
            onClick={openCompose}
          >
            + Compose new email
          </button>
        </header>

        {notice && (
          <div className="notice-message" role="status">
            <span>✓</span>
            {notice}
          </div>
        )}

        <section className="welcome-panel">
          <div>
            <span className="status-pill">
              <span />
              EMAIL OPERATIONS
            </span>

            <h2>Manage your outreach.</h2>

            <p>
              Schedule, organize, and track your email
              campaigns in one place.
            </p>
          </div>

          <div className="welcome-art">
            ✉
          </div>
        </section>

        <section className="stats-grid">
          <article className="stat-card">
            <span>Total emails</span>
            <strong>{emails.length}</strong>
            <small>Across this workspace</small>
          </article>

          <article className="stat-card">
            <span>Scheduled</span>
            <strong>
              {
                emails.filter(
                  (email) => email.status === 'Scheduled',
                ).length
              }
            </strong>
            <small>Waiting to be processed</small>
          </article>

          <article className="stat-card">
            <span>Sent emails</span>
            <strong>
              {
                emails.filter(
                  (email) => email.status === 'Sent',
                ).length
              }
            </strong>
            <small>Confirmed as sent</small>
          </article>

          <article className="stat-card">
            <span>Failed emails</span>
            <strong>
              {
                emails.filter(
                  (email) => email.status === 'Failed',
                ).length
              }
            </strong>
            <small>Require attention</small>
          </article>
        </section>

        <section className="email-panel">
          <div className="panel-heading">
            <div>
              <h2>Email activity</h2>
              <p>
                View and manage your scheduled and sent emails.
              </p>
            </div>

            <div className="search-box">
              <span>⌕</span>
              <input
                type="search"
                placeholder="Search emails"
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
              />
            </div>
          </div>

          {searchLoading && (
            <p className="field-help" role="status">Searching emails…</p>
          )}
          {searchError && (
            <p className="form-error" role="alert">{searchError}</p>
          )}

          <div className="tabs">
            <button
              className={
                activeTab === 'scheduled'
                  ? 'tab active-tab'
                  : 'tab'
              }
              onClick={() => setActiveTab('scheduled')}
              type="button"
            >
              Scheduled emails
            </button>

            <button
              className={
                activeTab === 'sent'
                  ? 'tab active-tab'
                  : 'tab'
              }
              onClick={() => setActiveTab('sent')}
              type="button"
            >
              Sent / failed emails
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>RECIPIENT</th>
                  <th>SUBJECT</th>
                  <th>
                    {activeTab === 'scheduled'
                      ? 'SCHEDULED TIME'
                      : 'TIME'}
                  </th>
                  <th>STATUS</th>
                </tr>
              </thead>

              <tbody>
                {visibleEmails.length === 0 ? (
                  <tr>
                    <td colSpan={4}>
                      <div className="empty-state">
                        <div className="empty-icon">
                          ✉
                        </div>

                        <strong>
                          No {activeTab} emails yet
                        </strong>

                        <p>
                          Your email activity will appear
                          here.
                        </p>

                        <button
                          className="secondary-button"
                          onClick={openCompose}
                          type="button"
                        >
                          Compose an email
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  visibleEmails.map((email) => (
                    <tr
                      key={email.id}
                      className="email-row"
                      onClick={() =>
                        setSelectedEmail(email)
                      }
                    >
                      <td>
                        <div className="recipient-cell">
                          <span className="mini-avatar">
                            {email.email
                              .charAt(0)
                              .toUpperCase()}
                          </span>

                          {email.email}
                        </div>
                      </td>

                      <td>
                        <strong className="subject-text">
                          {email.subject}
                        </strong>
                      </td>

                      <td>{email.scheduledAt}</td>

                      <td>
                        <span
                          className={`table-status ${email.status.toLowerCase()}`}
                        >
                          {email.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer>
          ReachInbox · Email operations workspace
        </footer>
      </main>

      {showCompose && (
        <div
          className="modal-backdrop"
          onClick={closeCompose}
        >
          <section
            className="compose-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
            onClick={(event) =>
              event.stopPropagation()
            }
          >
            <div className="compose-top">
              <button
                className="back-button compose-back"
                type="button"
                onClick={closeCompose}
              >
                ← Back
              </button>

              <button
                className="close-button"
                onClick={closeCompose}
                type="button"
                aria-label="Close compose email"
              >
                ×
              </button>
            </div>

            <div className="modal-heading">
              <div>
                <p className="eyebrow">
                  EMAIL WORKSPACE
                </p>

                <h2 id="compose-title">
                  Compose new email
                </h2>

                <p className="compose-description">
                  Create and schedule your next message.
                </p>
              </div>
            </div>

            <form onSubmit={handleSchedule} className="compose-form">
              <section className="compose-section lead-upload-section">
                <div className="lead-upload-heading">
                  <div>
                    <label htmlFor="lead-file">1. Recipients</label>
                    <p className="field-help">Upload a CSV/TXT lead list or enter addresses below. Duplicate addresses are removed.</p>
                  </div>
                  <button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()}>
                    Upload leads
                  </button>
                </div>
                <input ref={fileInputRef} id="lead-file" className="hidden-file-input" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={handleLeadFile} />
                {leadFileName && <div className="file-summary"><span aria-hidden="true">✓ </span>{leadFileName}</div>}
                <div className="recipient-count" aria-live="polite">
                  <strong>{(recipients.length || extractEmails(recipient).length).toLocaleString()}</strong>{' '}
                  valid unique recipient{(recipients.length || extractEmails(recipient).length) === 1 ? '' : 's'} detected
                </div>
                <label className="field-label" htmlFor="manual-recipients">Email addresses</label>
                <textarea
                  id="manual-recipients"
                  className="manual-recipient-input recipient-textarea"
                  rows={2}
                  placeholder="name@example.com, another@example.com"
                  value={recipient}
                  onChange={(event) => {
                    const value = event.target.value
                    setRecipient(value)
                    setRecipients(extractEmails(value))
                    setLeadFileName('')
                    setFormError('')
                  }}
                  aria-describedby="recipient-help"
                />
                <p id="recipient-help" className="field-help">Separate multiple addresses with commas, semicolons, spaces, or new lines.</p>
              </section>

              <section className="compose-section">
                <h3 className="compose-section-title">2. Message</h3>
                <label className="field-label" htmlFor="email-subject">Subject</label>
                <input id="email-subject" type="text" placeholder="e.g. Quick introduction" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} required />
                <p className="field-help">Keep the subject clear and relevant to your recipients.</p>

                <label className="field-label body-label" htmlFor="email-body">Email body</label>
                <textarea
                  id="email-body"
                  className="email-body-input"
                  rows={8}
                  placeholder={'Hi there,\n\nWrite your message here…\n\nBest,\nYour name'}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  required
                />
                <p className="field-help">This message is used for each recipient. Attachments are included if selected.</p>
              </section>

              <section className="compose-section sending-section">
                <h3 className="compose-section-title">3. Sending rules</h3>
                <label className="field-label" htmlFor="scheduled-at">Campaign start date and time</label>
                <input
                  id="scheduled-at"
                  type="datetime-local"
                  value={scheduledAt}
                  min={getMinimumScheduleTime()}
                  onChange={(event) => setScheduledAt(event.target.value)}
                  required
                />
                <p className="field-help">Defaults to five minutes from now. Choose another future time if needed. The queue can postpone sends when a rate limit is reached.</p>

                <div className="campaign-controls">
                  <label className="field-label" htmlFor="delay-seconds">
                    Delay between emails (seconds)
                    <input id="delay-seconds" type="number" min="1" step="1" value={delaySeconds} onChange={(event) => setDelaySeconds(event.target.value)} required />
                    <span className="field-help">Minimum spacing between individual sends. Default: 2 seconds.</span>
                  </label>
                  <label className="field-label" htmlFor="hourly-limit">
                    Hourly sending limit
                    <input id="hourly-limit" type="number" min="1" step="1" value={hourlyLimit} onChange={(event) => setHourlyLimit(event.target.value)} required />
                    <span className="field-help">Maximum emails per hour under the sender policy.</span>
                  </label>
                </div>
                <p className="rate-limit-note"><strong>When the limit is reached:</strong> pending emails should be delayed to the next available sending window, not discarded. The backend must enforce this across workers.</p>
              </section>

              <section className="compose-section attachment-section">
                <div className="lead-upload-heading">
                  <div>
                    <h3 className="compose-section-title">4. Attachments <span className="optional-label">Optional</span></h3>
                    <p className="field-help">Images and PDF files, up to 5 MB each.</p>
                  </div>
                  <button className="upload-button" type="button" onClick={() => attachmentInputRef.current?.click()}>Add files</button>
                </div>
                <input ref={attachmentInputRef} className="hidden-file-input" type="file" accept="image/*,.pdf,application/pdf" multiple onChange={handleAttachmentFiles} />
                {attachments.length > 0 && (
                  <div className="attachment-list">
                    {attachments.map((attachment) => (
                      <div className="attachment-chip" key={attachment.name}>
                        <span>{attachment.type === 'application/pdf' ? 'PDF' : 'IMG'}</span>
                        <div><strong>{attachment.name}</strong><small>{(attachment.size / 1024 / 1024).toFixed(2)} MB</small></div>
                        <button type="button" onClick={() => removeAttachment(attachment.name)} aria-label={`Remove ${attachment.name}`}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {formError && <p className="form-error" role="alert">{formError}</p>}

              <div className="modal-actions compose-actions">
                <button className="secondary-button" onClick={closeCompose} type="button" disabled={isScheduling}>Cancel</button>
                <button className="primary-button" type="submit" disabled={isScheduling}>
                  {isScheduling ? 'Scheduling campaign…' : 'Schedule campaign'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}

function Sidebar({
  user,
  profileInitials,
  showProfile,
  setShowProfile,
  openCompose,
}: {
  user: User
  profileInitials: string
  showProfile: boolean
  setShowProfile: React.Dispatch<
    React.SetStateAction<boolean>
  >
  openCompose: () => void
}) {
  async function handleLogout() {
    try {
      await signOut(auth)
      setShowProfile(false)
    } catch (error) {
      console.error('Sign-out failed:', error)
    }
  }

  return (
    <>
      <div className="brand">
        <div className="brand-icon">R</div>

        <div>
          <strong>ReachInbox</strong>
          <span>Email workspace</span>
        </div>
      </div>

      <p className="nav-label">WORKSPACE</p>

      <button
        className="nav-item active"
        type="button"
      >
        <span>▤</span>
        Email dashboard
      </button>

      <button
        className="nav-item"
        type="button"
        onClick={openCompose}
      >
        <span>＋</span>
        Compose email
      </button>

      <div className="sidebar-spacer" />

      {showProfile && (
        <div className="profile-menu">
          <div className="profile-menu-user">
            <div className="profile-menu-avatar">
              {profileInitials}
            </div>

            <div>
              <strong>
                {user.displayName ||
                  'Workspace user'}
              </strong>

              <span>
                {user.email}
              </span>
            </div>
          </div>

          <button
            className="logout-button"
            type="button"
            onClick={handleLogout}
          >
            <span>↪</span>
            Log out
          </button>
        </div>
      )}

      <div className="sidebar-bottom">
        <button
          className="avatar"
          type="button"
          title="Open profile menu"
          aria-label="Open profile menu"
          aria-expanded={showProfile}
          onClick={() =>
            setShowProfile(
              (current) => !current,
            )
          }
        >
          {user.photoURL ? (
            <img
              src={user.photoURL}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            profileInitials
          )}
        </button>

        <button
          className="profile-summary"
          type="button"
          onClick={() =>
            setShowProfile(
              (current) => !current,
            )
          }
        >
          <strong>
            {user.displayName ||
              'Workspace user'}
          </strong>

          <span>
            {user.email ||
              'Signed-in account'}
          </span>
        </button>

        <span className="profile-chevron">
          {showProfile ? '⌃' : '⌄'}
        </span>
      </div>
    </>
  )
}

function App() {
  const [loginMessage, setLoginMessage] =
    useState('')

  const [loading, setLoading] =
    useState(false)

  const [user, setUser] =
    useState(auth.currentUser)

  const [email, setEmail] =
    useState('')

  const [password, setPassword] =
    useState('')

  const [isCreatingAccount, setIsCreatingAccount] =
    useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (currentUser) => {
        setUser(currentUser)
        setLoading(false)
      },
    )

    return unsubscribe
  }, [])

  async function startGoogleLogin() {
    setLoginMessage('')
    setLoading(true)

    try {
      await signInWithPopup(
        auth,
        googleProvider,
      )
    } catch (error: unknown) {
      console.error(
        'Google sign-in failed:',
        error,
      )

      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error
          ? String(error.code)
          : ''

      if (
        code ===
        'auth/popup-closed-by-user'
      ) {
        setLoginMessage(
          'Sign-in was cancelled. Please try again.',
        )
      } else if (
        code === 'auth/unauthorized-domain'
      ) {
        setLoginMessage(
          'This domain is not authorized. Add localhost in Firebase Authentication settings.',
        )
      } else if (
        code === 'auth/popup-blocked'
      ) {
        setLoginMessage(
          'Your browser blocked the sign-in popup. Allow popups and try again.',
        )
      } else {
        setLoginMessage(
          'Google sign-in failed. Check your Firebase settings and try again.',
        )
      }

      setLoading(false)
    }
  }

  async function handleEmailAuth(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    setLoginMessage('')
    setLoading(true)

    try {
      if (isCreatingAccount) {
        await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        )
      } else {
        await signInWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        )
      }
    } catch (error: unknown) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error
          ? String(error.code)
          : ''

      if (
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password' ||
        code === 'auth/user-not-found'
      ) {
        setLoginMessage(
          'Incorrect email or password.',
        )
      } else if (
        code === 'auth/email-already-in-use'
      ) {
        setLoginMessage(
          'This email is already registered. Please sign in.',
        )
      } else if (
        code === 'auth/weak-password'
      ) {
        setLoginMessage(
          'Choose a password with at least 6 characters.',
        )
      } else if (
        code === 'auth/invalid-email'
      ) {
        setLoginMessage(
          'Please enter a valid email address.',
        )
      } else {
        console.error(
          'Email authentication failed:',
          error,
        )

        setLoginMessage(
          'Authentication failed. Please try again.',
        )
      }
    } finally {
      setLoading(false)
    }
  }

  if (user) {
    return <Dashboard user={user} />
  }

  return (
    <div className="login-page">
      <div className="login-decoration login-decoration-one" />
      <div className="login-decoration login-decoration-two" />

      <main className="login-layout">
        <section className="login-intro">
          <div className="login-brand">
            <div className="login-brand-icon">
              R
            </div>

            <span>ReachInbox</span>
          </div>

          <div className="login-copy">
            <span className="login-eyebrow">
              <span className="login-eyebrow-dot" />
              EMAIL WORKSPACE
            </span>

            <h1>
              Make every email
              <br />
              <span>count.</span>
            </h1>

            <p>
              Plan your outreach, schedule emails,
              and keep every conversation organized —
              all from one calm, focused workspace.
            </p>

            <div className="login-feature-list">
              <div>
                <span className="login-feature-check">
                  ✓
                </span>

                <span>
                  <strong>
                    Schedule with confidence
                  </strong>

                  <small>
                    Plan emails for the right time.
                  </small>
                </span>
              </div>

              <div>
                <span className="login-feature-check">
                  ✓
                </span>

                <span>
                  <strong>
                    Keep everything together
                  </strong>

                  <small>
                    Track scheduled and sent messages.
                  </small>
                </span>
              </div>

              <div>
                <span className="login-feature-check">
                  ✓
                </span>

                <span>
                  <strong>
                    Stay in control
                  </strong>

                  <small>
                    One simple place for your outreach.
                  </small>
                </span>
              </div>
            </div>
          </div>

          <p className="login-footnote">
            Simple email operations, built around
            your workflow.
          </p>
        </section>

        <section
          className="login-card"
          aria-labelledby="login-title"
        >
          <div className="login-card-mark">
            R
          </div>

          <p className="login-card-kicker">
            WELCOME TO REACHINBOX
          </p>

          <h2 id="login-title">
            Sign in to your workspace
          </h2>

          <p className="login-card-description">
            Use your Google account to securely
            access your email dashboard.
          </p>

          <button
            className="google-login-button"
            type="button"
            onClick={startGoogleLogin}
            disabled={loading}
          >
            <GoogleLogo />

            <span>
              {loading
                ? 'Please wait...'
                : 'Continue with Google'}
            </span>

            <span className="google-button-arrow">
              →
            </span>
          </button>

          <div className="login-divider">
            <span />
            <small>OR USE EMAIL</small>
            <span />
          </div>

          <form
            className="email-auth-form"
            onSubmit={handleEmailAuth}
          >
            <label htmlFor="login-email">
              Email address
            </label>

            <input
              id="login-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              required
            />

            <label htmlFor="login-password">
              Password
            </label>

            <input
              id="login-password"
              type="password"
              autoComplete={
                isCreatingAccount
                  ? 'new-password'
                  : 'current-password'
              }
              placeholder="At least 6 characters"
              minLength={6}
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              required
            />

            <button
              className="email-submit-button"
              type="submit"
              disabled={loading}
            >
              {loading
                ? 'Please wait...'
                : isCreatingAccount
                  ? 'Create account'
                  : 'Sign in with email'}
            </button>
          </form>

          <button
            className="auth-mode-toggle"
            type="button"
            onClick={() => {
              setIsCreatingAccount(
                (current) => !current,
              )

              setLoginMessage('')
            }}
          >
            {isCreatingAccount
              ? 'Already have an account? Sign in'
              : 'New to ReachInbox? Create an account'}
          </button>

          {loginMessage && (
            <p
              className="login-message"
              role="alert"
            >
              {loginMessage}
            </p>
          )}

          <div className="login-divider">
            <span />
            <small>SECURE ACCESS</small>
            <span />
          </div>

          <div className="login-security">
            <span className="login-lock">
              ⌑
            </span>

            <p>
              <strong>
                Your account stays yours
              </strong>

              <small>
                Google handles your sign-in. We
                won't ask for your Google password.
              </small>
            </p>
          </div>

          <p className="login-terms">
            By continuing, you agree to use
            ReachInbox responsibly.
          </p>
        </section>
      </main>
    </div>
  )
}

export default App