import { useState, useCallback } from 'react'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Browsers report CSV files with different MIME types (e.g. application/vnd.ms-excel on Windows),
// so the extension is the reliable check.
const isCsvFile = (file: File | undefined): file is File =>
  !!file && file.name.toLowerCase().endsWith('.csv');

// The API answers errors as { error: string }
async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.error === 'string') return data.error;
  } catch {
    // not JSON: use the fallback
  }
  return fallback;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [tableName, setTableName] = useState('');
  const [query, setQuery] = useState('');
  const [queryResponse, setQueryResponse] = useState<string | null>(null);
  const [isQuerying, setIsQuerying] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (isCsvFile(droppedFile)) {
      setFile(droppedFile);
      setUploadStatus(null);
    } else {
      setUploadStatus({ ok: false, text: 'Please choose a .csv file.' });
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (isCsvFile(selectedFile)) {
      setFile(selectedFile);
      setUploadStatus(null);
    } else if (selectedFile) {
      setUploadStatus({ ok: false, text: 'Please choose a .csv file.' });
    }
  };

  const handleUpload = async () => {
    if (!file || !tableName) return;

    setUploading(true);
    setUploadStatus(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('tableName', tableName);

    try {
      const response = await fetch(`${API_URL}/upload-csv`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error(await readError(response, 'Upload failed'));

      const data = await response.json();
      setUploadStatus({ ok: true, text: `Imported ${data.columnCount} columns into table "${data.tableName}".` });
      setFile(null);
      setTableName('');
    } catch (error) {
      console.error('Upload error:', error);
      setUploadStatus({ ok: false, text: error instanceof Error ? error.message : 'Upload failed' });
    } finally {
      setUploading(false);
    }
  };

  const handleQuery = async () => {
    if (!query) return;
    
    setIsQuerying(true);
    setQueryError(null);
    setQueryResponse(null);
    try {
      const response = await fetch(`${API_URL}/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: query }),
      });

      if (!response.ok) throw new Error(await readError(response, 'Query failed'));
      
      const data = await response.json();
      setQueryResponse(data.response);
    } catch (error) {
      console.error('Query error:', error);
      setQueryError(error instanceof Error ? error.message : 'Query failed');
    } finally {
      setIsQuerying(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="flex gap-4 max-w-7xl mx-auto">
        {/* Left Column - CSV Upload (1/3) */}
        <Card className="w-1/3">
          <CardHeader>
            <CardTitle>Upload CSV File</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <Label htmlFor="table-name">Table Name</Label>
              <input
                type="text"
                id="table-name"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
                placeholder="Enter table name"
              />
            </div>
            
            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary cursor-pointer"
              onClick={() => document.getElementById('file-upload')?.click()}
            >
              <input
                type="file"
                id="file-upload"
                className="hidden"
                accept=".csv"
                onChange={handleFileSelect}
              />
              <Label className="cursor-pointer block">
                {file ? file.name : 'Drag and drop a CSV file here, or click to select'}
              </Label>
            </div>

            {uploadStatus && (
              <p
                role={uploadStatus.ok ? 'status' : 'alert'}
                className={`mt-4 text-sm ${uploadStatus.ok ? 'text-green-600' : 'text-red-600'}`}
              >
                {uploadStatus.text}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button 
              onClick={handleUpload} 
              disabled={!file || !tableName || uploading}
              className="w-full"
            >
              {uploading ? 'Uploading...' : 'Upload CSV'}
            </Button>
          </CardFooter>
        </Card>

        {/* Right Column - Query Interface (2/3) */}
        <Card className="w-2/3">
          <CardHeader>
            <CardTitle>Query Your Data</CardTitle>
          </CardHeader>
          <CardContent>
            <Label htmlFor="query">Ask about your data</Label>
            <div className="flex gap-2">
              <input
                type="text"
                id="query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="flex-1 px-3 py-2 border rounded-md"
                placeholder="Ask a question about your data..."
              />
              <Button 
                onClick={handleQuery}
                disabled={!query || isQuerying}
              >
                Ask
              </Button>
            </div>

            {isQuerying && (
              <div className="mt-4">
                <Skeleton className="h-20 w-full" />
              </div>
            )}

            {queryError && !isQuerying && (
              <p role="alert" className="mt-4 text-sm text-red-600">{queryError}</p>
            )}

            {queryResponse && !isQuerying && (
              <div className="mt-4 p-4 bg-muted rounded-md">
                {queryResponse.split('\n').map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default App
