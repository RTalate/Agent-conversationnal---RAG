import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

// The API is replaced by a fake fetch: these tests check what the user sees and what is sent.

const API = 'http://localhost:3000'

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const csvFile = (name = 'customers.csv', type = 'text/csv') => new File(['a,b\n1,2\n'], name, { type })
const textFile = () => new File(['hello'], 'notes.txt', { type: 'text/plain' })

const fileInput = () => document.getElementById('file-upload') as HTMLInputElement
const dropZone = () => screen.getByText(/Drag and drop a CSV file here|\.csv$/).closest('div[class*="border-dashed"]') as HTMLElement
const tableNameInput = () => screen.getByLabelText('Table Name')
const questionInput = () => screen.getByLabelText('Ask about your data')
const uploadButton = () => screen.getByRole('button', { name: /Upload CSV|Uploading/ })
const askButton = () => screen.getByRole('button', { name: 'Ask' })

describe('upload', () => {
  it('starts with the upload button disabled', () => {
    render(<App />)
    expect(uploadButton()).toBeDisabled()
  })

  it('needs both a file and a table name', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.upload(fileInput(), csvFile())
    expect(uploadButton()).toBeDisabled()

    await user.type(tableNameInput(), 'customers')
    expect(uploadButton()).toBeEnabled()
  })

  it('accepts a CSV file whatever MIME type the browser reports (Windows says application/vnd.ms-excel)', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.upload(fileInput(), csvFile('customers.csv', 'application/vnd.ms-excel'))

    expect(screen.getByText('customers.csv')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('accepts a CSV file with no MIME type, and an uppercase extension', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.upload(fileInput(), csvFile('EXPORT.CSV', ''))

    expect(screen.getByText('EXPORT.CSV')).toBeInTheDocument()
  })

  it('refuses a file that is not a CSV when it is picked, and says so', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<App />)

    await user.upload(fileInput(), textFile())

    expect(screen.getByRole('alert')).toHaveTextContent('Please choose a .csv file.')
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument()
  })

  it('refuses a file that is not a CSV when it is dropped, and accepts one that is', () => {
    render(<App />)

    fireEvent.drop(dropZone(), { dataTransfer: { files: [textFile()] } })
    expect(screen.getByRole('alert')).toHaveTextContent('Please choose a .csv file.')

    fireEvent.drop(dropZone(), { dataTransfer: { files: [csvFile('dropped.csv')] } })
    expect(screen.getByText('dropped.csv')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('sends the file and the table name to the API, then confirms and resets the form', async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch(() => jsonResponse(200, { tableName: 'customers', columnCount: 12 }))
    render(<App />)

    await user.upload(fileInput(), csvFile())
    await user.type(tableNameInput(), 'customers')
    await user.click(uploadButton())

    expect(await screen.findByRole('status')).toHaveTextContent('Imported 12 columns into table "customers".')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/upload-csv`)
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form.get('tableName')).toBe('customers')
    expect((form.get('file') as File).name).toBe('customers.csv')
    expect(tableNameInput()).toHaveValue('')
    expect(uploadButton()).toBeDisabled()
  })

  it('shows "Uploading..." and blocks a second click while the upload is running', async () => {
    const user = userEvent.setup()
    const pending = deferred<Response>()
    const fetchMock = stubFetch(() => pending.promise)
    render(<App />)
    await user.upload(fileInput(), csvFile())
    await user.type(tableNameInput(), 'customers')

    await user.click(uploadButton())

    expect(uploadButton()).toHaveTextContent('Uploading...')
    expect(uploadButton()).toBeDisabled()
    await user.click(uploadButton())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    pending.resolve(jsonResponse(200, { tableName: 'customers', columnCount: 2 }))
    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(uploadButton()).toHaveTextContent('Upload CSV')
  })

  it('shows the reason given by the API, and keeps the form so it can be corrected', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(() => jsonResponse(400, { error: 'Invalid table name: use only letters, digits and underscores' }))
    render(<App />)
    await user.upload(fileInput(), csvFile())
    await user.type(tableNameInput(), 'my table')

    await user.click(uploadButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid table name: use only letters, digits and underscores')
    expect(tableNameInput()).toHaveValue('my table')
    expect(screen.getByText('customers.csv')).toBeInTheDocument()
    expect(uploadButton()).toBeEnabled()
  })

  it('shows the conflict when the table name is taken by a table the application did not create', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(() => jsonResponse(409, { error: 'A table named "users" already exists and was not created by this application. Choose another name.' }))
    render(<App />)
    await user.upload(fileInput(), csvFile())
    await user.type(tableNameInput(), 'users')

    await user.click(uploadButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists and was not created by this application')
  })

  it('falls back to a generic message when the error is not JSON', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }))
    render(<App />)
    await user.upload(fileInput(), csvFile())
    await user.type(tableNameInput(), 'customers')

    await user.click(uploadButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed')
  })

  it('shows the network error when the API cannot be reached', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(() => { throw new TypeError('Failed to fetch') })
    render(<App />)
    await user.upload(fileInput(), csvFile())
    await user.type(tableNameInput(), 'customers')

    await user.click(uploadButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch')
    expect(uploadButton()).toBeEnabled()
  })

  it('clears the previous message when a new file is chosen', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<App />)
    await user.upload(fileInput(), textFile())
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.upload(fileInput(), csvFile())

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('questions', () => {
  it('disables Ask until a question is typed', async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(askButton()).toBeDisabled()

    await user.type(questionInput(), 'How many customers?')

    expect(askButton()).toBeEnabled()
  })

  it('sends the question to the API and shows the answer, one paragraph per line', async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch(() => jsonResponse(200, { response: 'There are 1000 customers.\nMost are in France.' }))
    render(<App />)

    await user.type(questionInput(), 'How many customers?')
    await user.click(askButton())

    expect(await screen.findByText('There are 1000 customers.')).toBeInTheDocument()
    expect(screen.getByText('Most are in France.')).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/query`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ message: 'How many customers?' })
  })

  it('shows a loading state, and blocks a second question, while waiting for the answer', async () => {
    const user = userEvent.setup()
    const pending = deferred<Response>()
    const fetchMock = stubFetch(() => pending.promise)
    const { container } = render(<App />)
    await user.type(questionInput(), 'How many customers?')

    await user.click(askButton())

    expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
    expect(askButton()).toBeDisabled()
    await user.click(askButton())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    pending.resolve(jsonResponse(200, { response: 'Done.' }))
    expect(await screen.findByText('Done.')).toBeInTheDocument()
    expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument()
    expect(askButton()).toBeEnabled()
  })

  it('shows the error of the API', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(() => jsonResponse(500, { error: 'Failed to process query' }))
    render(<App />)

    await user.type(questionInput(), 'How many customers?')
    await user.click(askButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to process query')
  })

  it('falls back to a generic message when the error is not JSON', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFetch(() => new Response('Bad gateway', { status: 502 }))
    render(<App />)

    await user.type(questionInput(), 'How many customers?')
    await user.click(askButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Query failed')
  })

  it('removes the previous answer as soon as a new question is sent, and never shows it next to an error', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = deferred<Response>()
    let calls = 0
    stubFetch(() => (calls++ === 0 ? jsonResponse(200, { response: 'First answer.' }) : second.promise))
    render(<App />)
    await user.type(questionInput(), 'First question')
    await user.click(askButton())
    expect(await screen.findByText('First answer.')).toBeInTheDocument()

    await user.clear(questionInput())
    await user.type(questionInput(), 'Second question')
    await user.click(askButton())
    expect(screen.queryByText('First answer.')).not.toBeInTheDocument()

    second.resolve(jsonResponse(500, { error: 'Failed to process query' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('First answer.')).not.toBeInTheDocument()
  })

  it('removes the previous error when a new question is sent', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    stubFetch(() => (calls++ === 0 ? jsonResponse(500, { error: 'Failed to process query' }) : jsonResponse(200, { response: 'It worked.' })))
    render(<App />)
    await user.type(questionInput(), 'Question')
    await user.click(askButton())
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.click(askButton())

    expect(await screen.findByText('It worked.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('API address', () => {
  it('uses VITE_API_URL when it is set', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test')
    vi.resetModules()
    const { default: ConfiguredApp } = await import('./App')
    const user = userEvent.setup()
    const fetchMock = stubFetch(() => jsonResponse(200, { response: 'ok' }))
    render(<ConfiguredApp />)

    await user.type(questionInput(), 'Question')
    await user.click(askButton())

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.test/query')
  })
})
