import { query } from './db';
import { queryAI, parseAIJson } from './query-ai';
import { quoteIdent } from './sql-safety';

export async function analyzeTable(
  tableName: string,
  sampleSize: number = 1000,
  maxDistinctValues: number = 100
): Promise<Record<string, any>> {
  try {
    // Get table info and sample data
    const sampleQuery = `
      SELECT * FROM ${quoteIdent(tableName)}
      ORDER BY RANDOM()
      LIMIT ${sampleSize}
    `;
    const result = await query(sampleQuery);
    const columns = result.fields.map(field => field.name);

    const dataDictionary: Record<string, any> = {};

    for (const column of columns) {
      const columnData = result.rows.map(row => row[column]);
      const distinctValues = new Set(columnData);
      const nullCount = columnData.filter(value => value === null).length;
      const columnType = result.fields.find(field => field.name === column)?.dataTypeID;

      dataDictionary[column] = {
        type: getHumanReadableType(columnType),
        distinctCount: distinctValues.size,
        nullCount,
        // relative to the rows actually sampled, which is fewer than sampleSize for small tables
        nullPercentage: columnData.length ? (nullCount / columnData.length) * 100 : 0,
      };

      if (distinctValues.size <= maxDistinctValues) {
        const valueCounts = columnData.reduce((acc, value) => {
          acc[value] = (acc[value] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

        dataDictionary[column].topValues = Object.entries(valueCounts)
          .sort((a: any, b: any) => b[1] - a[1])
          .slice(0, 5)
          .map(([value, count]) => ({ value, count }));
      }

      // Handle numeric columns
      if (getHumanReadableType(columnType) === 'number') {
        const numericValues = columnData.filter(value => value !== null).map(Number);
        if (numericValues.length > 0) {
          dataDictionary[column].min = Math.min(...numericValues);
          dataDictionary[column].max = Math.max(...numericValues);
        }
      }
      // Handle date/timestamp columns
      else if (getHumanReadableType(columnType) === 'date') {
        const dateValues = columnData.filter(value => value !== null).map(value => new Date(value));
        if (dateValues.length > 0) {
          dataDictionary[column].min = new Date(Math.min(...dateValues.map(date => date.getTime())));
          dataDictionary[column].max = new Date(Math.max(...dateValues.map(date => date.getTime())));
        }
      }
    }

    const llmSummary = await generateLLMSummary(dataDictionary);
    console.log(llmSummary);
    return llmSummary;

  } catch (error) {
    console.error('Error analyzing table:', error);
    throw new Error('Failed to analyze table');
  }
} 

async function generateLLMSummary(dataDictionary: Record<string, any>): Promise<Record<string, string>> {
  const systemPrompt = `You are a data analyst tasked with providing concise but complete descriptions of data fields. Include data type andnotable information about sample values where relevant. Be brief but ensure every field is described.`;

  const userPrompt = `Given the following data dictionary, provide a description for each field:

${JSON.stringify(dataDictionary, null, 2)}

Format your response as a JSON object where keys are field names and values are descriptions.`;

  const response = await queryAI(systemPrompt, userPrompt, true);
  return parseAIJson<Record<string, string>>(response, 'table analysis');
}

function getHumanReadableType(typeId: number | undefined): string {
  if (!typeId) return 'unknown';
  
  const typeMap: Record<string, string> = {
    '16': 'boolean',
    '20': 'number', // bigint
    '21': 'number', // smallint
    '23': 'number', // integer
    '700': 'number', // real/float4
    '701': 'number', // double precision/float8
    '1082': 'date', // date
    '1114': 'date', // timestamp without timezone
    '1184': 'date', // timestamp with timezone
    '25': 'text', // text
    '1043': 'text', // varchar
    '1700': 'number', // numeric/decimal
  };

  return typeMap[typeId.toString()] || 'unknown';
}