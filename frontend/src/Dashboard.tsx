import { useState, useEffect, useReducer, FormEvent, ChangeEvent } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar, Line } from 'react-chartjs-2'
import './App.css'
import './Dashboard.css'

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
)

const STORAGE_KEY = 'api_key'

// API Response Types
interface ScoreBucket {
  bucket: string
  count: number
}

interface TimelineEntry {
  date: string
  submissions: number
}

interface PassRateEntry {
  task: string
  avg_score: number
  attempts: number
}

interface LabItem {
  id: number
  type: string
  title: string
  created_at: string
}

// API Response Types
interface ScoresResponse {
  scores: ScoreBucket[]
}

interface TimelineResponse {
  timeline: TimelineEntry[]
}

interface PassRatesResponse {
  pass_rates: PassRateEntry[]
}

interface LabsResponse {
  labs: LabItem[]
}

// Fetch State Types
type FetchState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; message: string }

type FetchAction<T> =
  | { type: 'fetch_start' }
  | { type: 'fetch_success'; data: T }
  | { type: 'fetch_error'; message: string }

function createFetchReducer<T>() {
  return function fetchReducer(
    _state: FetchState<T>,
    action: FetchAction<T>,
  ): FetchState<T> {
    switch (action.type) {
      case 'fetch_start':
        return { status: 'loading' }
      case 'fetch_success':
        return { status: 'success', data: action.data }
      case 'fetch_error':
        return { status: 'error', message: action.message }
    }
  }
}

// Chart data preparation
interface BarChartData {
  labels: string[]
  datasets: {
    label: string
    data: number[]
    backgroundColor: string
  }[]
}

interface LineChartData {
  labels: string[]
  datasets: {
    label: string
    data: number[]
    borderColor: string
    backgroundColor: string
    fill: boolean
  }[]
}

function prepareBarChartData(buckets: ScoreBucket[]): BarChartData {
  return {
    labels: buckets.map((b) => b.bucket),
    datasets: [
      {
        label: 'Number of Students',
        data: buckets.map((b) => b.count),
        backgroundColor: 'rgba(54, 162, 235, 0.6)',
      },
    ],
  }
}

function prepareLineChartData(entries: TimelineEntry[]): LineChartData {
  return {
    labels: entries.map((e) => e.date),
    datasets: [
      {
        label: 'Submissions',
        data: entries.map((e) => e.submissions),
        borderColor: 'rgba(75, 192, 192, 1)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        fill: true,
      },
    ],
  }
}

function Dashboard() {
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_KEY) ?? '')
  const [draft, setDraft] = useState('')
  const [selectedLab, setSelectedLab] = useState<string>('')

  const [scoresState, scoresDispatch] = useReducer(
    createFetchReducer<ScoreBucket[]>(),
    { status: 'idle' },
  )
  const [timelineState, timelineDispatch] = useReducer(
    createFetchReducer<TimelineEntry[]>(),
    { status: 'idle' },
  )
  const [passRatesState, passRatesDispatch] = useReducer(
    createFetchReducer<PassRateEntry[]>(),
    { status: 'idle' },
  )
  const [labsState, labsDispatch] = useReducer(
    createFetchReducer<LabItem[]>(),
    { status: 'idle' },
  )

  // Fetch labs list on mount
  useEffect(() => {
    if (!token) return

    dispatchLabs({ type: 'fetch_start' })

    fetch('/items/', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: LabItem[]) => {
        const labs = data.filter((item) => item.type === 'lab')
        dispatchLabs({ type: 'fetch_success', data: labs })
        if (labs.length > 0 && !selectedLab) {
          const firstLabId = extractLabIdFromTitle(labs[0].title)
          if (firstLabId) {
            setSelectedLab(firstLabId)
          }
        }
      })
      .catch((err: Error) => dispatchLabs({ type: 'fetch_error', message: err.message }))
  }, [token])

  // Fetch analytics when lab selection changes
  useEffect(() => {
    if (!token || !selectedLab) return

    fetchAnalytics(selectedLab)
  }, [token, selectedLab])

  async function fetchAnalytics(labId: string) {
    dispatchScores({ type: 'fetch_start' })
    dispatchTimeline({ type: 'fetch_start' })
    dispatchPassRates({ type: 'fetch_start' })

    const endpoints = [
      {
        url: `/analytics/scores?lab=${encodeURIComponent(labId)}`,
        dispatch: dispatchScores,
        transform: (data: unknown): ScoreBucket[] => {
          if (!Array.isArray(data)) return []
          return data.filter(
            (item): item is ScoreBucket =>
              typeof item === 'object' &&
              item !== null &&
              'bucket' in item &&
              'count' in item &&
              typeof (item as ScoreBucket).bucket === 'string' &&
              typeof (item as ScoreBucket).count === 'number',
          )
        },
      },
      {
        url: `/analytics/timeline?lab=${encodeURIComponent(labId)}`,
        dispatch: dispatchTimeline,
        transform: (data: unknown): TimelineEntry[] => {
          if (!Array.isArray(data)) return []
          return data.filter(
            (item): item is TimelineEntry =>
              typeof item === 'object' &&
              item !== null &&
              'date' in item &&
              'submissions' in item &&
              typeof (item as TimelineEntry).date === 'string' &&
              typeof (item as TimelineEntry).submissions === 'number',
          )
        },
      },
      {
        url: `/analytics/pass-rates?lab=${encodeURIComponent(labId)}`,
        dispatch: dispatchPassRates,
        transform: (data: unknown): PassRateEntry[] => {
          if (!Array.isArray(data)) return []
          return data.filter(
            (item): item is PassRateEntry =>
              typeof item === 'object' &&
              item !== null &&
              'task' in item &&
              'avg_score' in item &&
              'attempts' in item &&
              typeof (item as PassRateEntry).task === 'string' &&
              typeof (item as PassRateEntry).avg_score === 'number' &&
              typeof (item as PassRateEntry).attempts === 'number',
          )
        },
      },
    ]

    await Promise.all(
      endpoints.map(async ({ url, dispatch, transform }) => {
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          dispatch({ type: 'fetch_success', data: transform(data) })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          dispatch({ type: 'fetch_error', message })
        }
      }),
    )
  }

  function extractLabIdFromTitle(title: string): string | null {
    const match = title.match(/Lab\s+(\d+)/i)
    if (match) {
      const num = match[1].padStart(2, '0')
      return `lab-${num}`
    }
    return null
  }

  function handleConnect(e: FormEvent) {
    e.preventDefault()
    const trimmed = draft.trim()
    if (!trimmed) return
    localStorage.setItem(STORAGE_KEY, trimmed)
    setToken(trimmed)
  }

  function handleDisconnect() {
    localStorage.removeItem(STORAGE_KEY)
    setToken('')
    setDraft('')
    setSelectedLab('')
  }

  function handleLabChange(e: ChangeEvent<HTMLSelectElement>) {
    setSelectedLab(e.target.value)
  }

  // Dispatch functions with proper types
  function dispatchScores(action: FetchAction<ScoreBucket[]>) {
    scoresDispatch(action)
  }

  function dispatchTimeline(action: FetchAction<TimelineEntry[]>) {
    timelineDispatch(action)
  }

  function dispatchPassRates(action: FetchAction<PassRateEntry[]>) {
    passRatesDispatch(action)
  }

  function dispatchLabs(action: FetchAction<LabItem[]>) {
    labsDispatch(action)
  }

  if (!token) {
    return (
      <form className="token-form" onSubmit={handleConnect}>
        <h1>Dashboard</h1>
        <p>Enter your API key to connect.</p>
        <input
          type="password"
          placeholder="Token"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit">Connect</button>
      </form>
    )
  }

  return (
    <div className="dashboard">
      <header className="app-header">
        <h1>Analytics Dashboard</h1>
        <button className="btn-disconnect" onClick={handleDisconnect}>
          Disconnect
        </button>
      </header>

      <div className="lab-selector">
        <label htmlFor="lab-select">Select Lab:</label>
        <select
          id="lab-select"
          value={selectedLab}
          onChange={handleLabChange}
          disabled={labsState.status !== 'success'}
        >
          <option value="">-- Select a lab --</option>
          {labsState.status === 'success' &&
            labsState.data.map((lab) => (
              <option key={lab.id} value={extractLabIdFromTitle(lab.title) ?? `lab-${lab.id}`}>
                {lab.title}
              </option>
            ))}
        </select>
      </div>

      {labsState.status === 'loading' && <p>Loading labs...</p>}
      {labsState.status === 'error' && <p>Error loading labs: {labsState.message}</p>}

      {!selectedLab && labsState.status === 'success' && (
        <p>Please select a lab to view analytics.</p>
      )}

      {selectedLab && (
        <>
          <section className="dashboard-section">
            <h2>Score Distribution</h2>
            {scoresState.status === 'loading' && <p>Loading scores...</p>}
            {scoresState.status === 'error' && <p>Error: {scoresState.message}</p>}
            {scoresState.status === 'success' && scoresState.data.length > 0 && (
              <div className="chart-container">
                <Bar
                  data={prepareBarChartData(scoresState.data)}
                  options={{
                    responsive: true,
                    plugins: {
                      legend: { display: false },
                      title: { display: true, text: 'Scores by Bucket' },
                    },
                  }}
                />
              </div>
            )}
          </section>

          <section className="dashboard-section">
            <h2>Submissions Timeline</h2>
            {timelineState.status === 'loading' && <p>Loading timeline...</p>}
            {timelineState.status === 'error' && <p>Error: {timelineState.message}</p>}
            {timelineState.status === 'success' && timelineState.data.length > 0 && (
              <div className="chart-container">
                <Line
                  data={prepareLineChartData(timelineState.data)}
                  options={{
                    responsive: true,
                    plugins: {
                      legend: { display: false },
                      title: { display: true, text: 'Submissions per Day' },
                    },
                  }}
                />
              </div>
            )}
          </section>

          <section className="dashboard-section">
            <h2>Pass Rates per Task</h2>
            {passRatesState.status === 'loading' && <p>Loading pass rates...</p>}
            {passRatesState.status === 'error' && <p>Error: {passRatesState.message}</p>}
            {passRatesState.status === 'success' && passRatesState.data.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Avg Score</th>
                    <th>Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {passRatesState.data.map((entry, index) => (
                    <tr key={index}>
                      <td>{entry.task}</td>
                      <td>{entry.avg_score}</td>
                      <td>{entry.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  )
}

export default Dashboard
